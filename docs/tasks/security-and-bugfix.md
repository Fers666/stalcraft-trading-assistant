# ТЗ: Security & Bugfix — 10 findings из code review

Дата: 2026-06-17  
Источник: автоматический code review (8 angles, high effort)

---

## Scope

Два исполнителя, параллельно:
- **backend-dev** — Fixes 1, 2, 4+5, 6, 8
- **frontend-dev** — Fixes 3, 7, 9, 10

Каждый fix — минимальное хирургическое изменение. Никаких рефакторов вне описанного.

---

## Backend (backend-dev)

### Fix 1 · security.py — токен без проверки типа (`CRITICAL`)

**Файл:** `backend/app/core/security.py`

**Проблема:** `create_access_token` не включает поле `"type"` в payload. `decode_token` не проверяет тип. Refresh-токен (у которого `"type": "refresh"`) принимается как access-токен в `get_current_user`.

**Что изменить:**

1. В `create_access_token` добавить `"type": "access"` в payload:
```python
def create_access_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "exp": expire, "type": "access"},
        settings.secret_key, algorithm=ALGORITHM,
    )
```

2. `decode_token` принять параметр `expected_type: str = "access"` и проверять его:
```python
def decode_token(token: str, expected_type: str = "access") -> Optional[int]:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        if payload.get("type") != expected_type:
            return None
        return int(payload["sub"])
    except JWTError:
        return None
```

3. В `dependencies.py` вызов без изменений (`expected_type="access"` по умолчанию).

4. В `auth.py` в `/refresh` эндпоинте заменить inline `_jwt.decode` + ручную проверку типа на `decode_token(payload.refresh_token, expected_type="refresh")`:
```python
@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    user_id = decode_token(payload.refresh_token, expected_type="refresh")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    ...
```
Импорты inline `_jwt`, `_settings`, `ALGORITHM` из `/refresh` убрать (были нужны только для этого блока).

---

### Fix 2 · auth.py — `/auth/refresh` не проверяет `is_active` (`HIGH`)

**Файл:** `backend/app/api/v1/endpoints/auth.py`

**Проблема:** строка 102 проверяет `not user or not user.is_approved`, но пропускает `is_active`. Деактивированный пользователь (забаненный) может бесконечно обновлять токены.

**Что изменить:** добавить `or not user.is_active` в условие:
```python
if not user or not user.is_approved or not user.is_active:
    raise HTTPException(status_code=401, detail="User not found or not approved")
```

*(Одна строка.)*

---

### Fix 4+5 · client.py + api_cache.py + collectors.py — race condition на `stalcraft_client.region` (`HIGH`)

**Файлы:**
- `backend/app/services/collector/client.py`
- `backend/app/services/cache/api_cache.py`
- `backend/app/tasks/collectors.py`

**Проблема:** `stalcraft_client.region` — разделяемый mutable атрибут. Паттерн `stalcraft_client.region = X; await ...; stalcraft_client.region = original` не атомарен в async-контексте: два concurrent вызова могут перемешать регионы → данные одного региона сохраняются под ключом другого.

**Решение (Вариант Б):** убрать мутацию, передавать `region` как параметр.

**1. client.py** — добавить `region` как явный параметр к методам, убрать использование `self.region` в этих методах:

```python
async def get_auction_lots(self, item_id: str, region: str, offset: int = 0, limit: int = 200) -> dict:
    return await self._request(
        "GET", f"/{region}/auction/{item_id}/lots",
        cost=TokenCost.LOTS,
        params={"offset": offset, "limit": min(limit, 200), "additional": "true"},
    )

async def get_auction_history(self, item_id: str, region: str, offset: int = 0, limit: int = 200) -> dict:
    return await self._request(
        "GET", f"/{region}/auction/{item_id}/history",
        cost=TokenCost.HISTORY,
        params={"offset": offset, "limit": min(limit, 200), "additional": "true"},
    )

async def get_emission(self, region: str | None = None) -> dict:
    r = region or self.region
    return await self._request("GET", f"/{r}/emission", cost=TokenCost.EMISSION)
```

`self.region` в `__init__` оставить — используется как дефолт для `get_emission` и любых прямых вызовов без override.

**2. api_cache.py** — обновить `get_or_fetch_lots` (строки 106-112): убрать мутацию региона, передать напрямую:

```python
async def get_or_fetch_lots(self, region: str, item_id: str) -> dict:
    cached = await self.get_lots(region, item_id)
    if cached is not None:
        cached["_from_cache"] = True
        return cached

    from app.services.collector.client import stalcraft_client
    data = await stalcraft_client.get_auction_lots(item_id, region=region)

    await self.set_lots(region, item_id, data)
    data["_from_cache"] = False
    return data
```

**3. collectors.py** — в `_collect_lots_for_item` (строки 261-273) убрать мутацию `stalcraft_client.region`:

```python
# БЫЛО:
client_region = stalcraft_client.region
stalcraft_client.region = entry.region
try:
    data = await stalcraft_client.get_auction_lots(entry.item_id)
    ...
finally:
    stalcraft_client.region = client_region

# СТАЛО:
data = await stalcraft_client.get_auction_lots(entry.item_id, region=entry.region)
...
```

Аналогично в `_collect_history_for_item` — найти и убрать мутацию `stalcraft_client.region`, передать `region=entry.region` напрямую.

---

### Fix 6 · collectors.py — NameError в `finally` блоке (`MEDIUM`)

**Файл:** `backend/app/tasks/collectors.py`, около строки 396

**Проблема:** `r = aioredis.from_url(...)` объявлен до `try`. Если `from_url` бросает исключение, `r` не присвоен, и `finally: await r.aclose()` выдаёт `NameError`, маскируя исходную ошибку.

**Что изменить:**

```python
# БЫЛО:
r = aioredis.from_url(settings.redis_url, decode_responses=True)
try:
    for entry in entries:
        ...
finally:
    await r.aclose()

# СТАЛО:
r = None
try:
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    for entry in entries:
        ...
finally:
    if r is not None:
        await r.aclose()
```

---

### Fix 8 · profitable_lots.py — ложные sell_options при отсутствии отфильтрованной истории (`MEDIUM`)

**Файл:** `backend/app/services/profitable_lots.py`, строка 184

**Проблема:** когда активен фильтр по quality/enchant, но история продаж по этому фильтру пуста (`prices = []`), код подставляет `vol_for_opts = volume_7d` (суммарный объём всех качеств). `make_sell_options` генерирует рекомендации с многократно завышенным объёмом.

**Что изменить:** строку 184 заменить и обнулить `sell_options` при отсутствии данных:

```python
# БЫЛО (строка 184):
vol_for_opts = vol if prices else volume_7d

# СТАЛО:
vol_for_opts = vol if prices else None
```

Далее в том же блоке, где вычисляется `sell_options` (строка 194):

```python
# БЫЛО:
sell_options = make_sell_options(ref, vol_for_opts)

# СТАЛО:
sell_options = make_sell_options(ref, vol_for_opts) if vol_for_opts is not None else None
```

Критерий: при `prices=[]` и активном фильтре в возвращаемом dict `sell_options` должен быть `None` (или отсутствовать).

---

## Frontend (frontend-dev)

### Fix 3 · App.tsx — `AdminRoute` рендерит детей при `user=null` (`HIGH`)

**Файл:** `frontend/src/App.tsx`, строка 28

**Проблема:** пока `fetchMe` не завершился (`user=null`), условие `user && !user.is_admin` ложно → `AdminPage` рендерится любому токен-держателю до разрешения промиса.

**Что изменить:** добавить промежуточный случай — если токен есть, но `user` ещё `null`, вернуть `null` (не рендерить ничего):

```tsx
function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const token = localStorage.getItem('access_token')
  if (!token) return <Navigate to="/" replace />
  if (!user) return null                              // ← fetchMe ещё не вернул
  if (!user.is_admin) return <Navigate to="/app/monitoring" replace />
  return <>{children}</>
}
```

---

### Fix 7 · GlobalFeed.tsx — интервал сбрасывается при каждом обновлении watchlist (`MEDIUM`)

**Файл:** `frontend/src/components/GlobalFeed.tsx`, строка 76

**Проблема:** `useEffect` зависит от `watchlist` (ссылка на массив). `loadWatchlistAndStats` каждый раз создаёт новый массив → effect перезапускается → 30-секундный интервал сбрасывается в ноль → лоты фактически не обновляются по расписанию.

**Что изменить:** стабилизировать зависимость через строку из ID:

```tsx
// перед useEffect:
const watchlistIds = watchlist.map((w) => w.id).join(',')

// useEffect:
useEffect(() => {
  if (!watchlistIds) return
  loadAllLots()
  const t = setInterval(loadAllLots, 30_000)
  return () => clearInterval(t)
}, [watchlistIds, loadAllLots])
```

Аналогично третий `useEffect` (строки 84-89), который тоже зависит от `watchlist`:

```tsx
useEffect(() => {
  const hasPending = watchlist.some(e => !e.last_successful_check)
  if (!hasPending) return
  const t = setInterval(() => loadWatchlistAndStats(true), 30_000)
  return () => clearInterval(t)
}, [watchlistIds, loadWatchlistAndStats])
```

*(здесь `watchlist.some(...)` внутри тела корректно — читает актуальный closure-значение.)*

---

### Fix 9 · useRefreshCooldown.ts — boolean-зависимость в useEffect (`MEDIUM`)

**Файл:** `frontend/src/hooks/useRefreshCooldown.ts`, строка 32

**Проблема:** `[secondsLeft > 0]` — boolean-зависимость. При вызове `startCooldown()` в активном кулдауне (когда `secondsLeft > 0` → `true`) effect не перезапускается, старый интервал не чистится, возникают два одновременных интервала.

**Что изменить:** заменить зависимость с булевого выражения на само значение:

```ts
// БЫЛО:
}, [secondsLeft > 0])

// СТАЛО:
}, [secondsLeft])
```

Одна строка. Остальной код хука не трогать.

---

### Fix 10 · SettingsPage.tsx — двойной запрос `/telegram/status` (`LOW`)

**Файл:** `frontend/src/pages/SettingsPage.tsx`, строки 80-88

**Проблема:** внутри `setInterval` оба вызова — `loadTgStatus()` и `api.get('/telegram/status')` — делают одинаковый запрос. Второй глотает ошибки (`.catch(() => ({ data: null }))`), пользователь не видит проблем с API.

**Что изменить:** удалить inline `api.get(...)`, использовать только `loadTgStatus()`. Логику `setLinkCode(null)` перенести в реакцию на изменение состояния из store:

```tsx
useEffect(() => {
  if (!linkCode) return
  const t = setInterval(async () => {
    await loadTgStatus()
  }, 5000)
  return () => clearInterval(t)
}, [linkCode, loadTgStatus])
```

Определить откуда store отдаёт `is_linked` (скорее всего `tgStatus?.is_linked`) и добавить отдельный `useEffect` для реакции на изменение флага:

```tsx
useEffect(() => {
  if (tgStatus?.is_linked && linkCode) {
    setLinkCode(null)
    setCodeTimer(0)
  }
}, [tgStatus?.is_linked, linkCode])
```

---

## Критерии готовности

- [ ] Fix 1: refresh-токен использованный как Bearer возвращает 401
- [ ] Fix 2: деактивированный пользователь с валидным refresh-токеном получает 401 на `/auth/refresh`
- [ ] Fix 4+5: `stalcraft_client.region` нигде не мутируется вне `__init__`; grep по `stalcraft_client.region =` (с пробелом и знаком `=`) возвращает только `__init__`
- [ ] Fix 6: при недоступном Redis `_publish_signals` выбрасывает исходный exception, не NameError
- [ ] Fix 8: при `prices=[]` в возвращаемом dict `sell_options is None`
- [ ] Fix 3: при холодной загрузке `/app/admin` не-админом — страница не рендерится до разрешения fetchMe
- [ ] Fix 7: `watchlistIds` используется как зависимость в обоих lots-related useEffect
- [ ] Fix 9: в `useRefreshCooldown.ts` зависимость `[secondsLeft]`, не `[secondsLeft > 0]`
- [ ] Fix 10: в `SettingsPage.tsx` один вызов к `/telegram/status` за тик интервала
