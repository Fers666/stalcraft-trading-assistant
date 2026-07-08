# Деплой — продакшн (VPS)

## Инфраструктура
- **Сервер:** 161.104.44.231, Debian 13, 2 vCPU / 4 ГБ / 50 ГБ
- **Пользователь:** `evgen` (shell: fish)
- **Проект:** `/home/evgen/app/`
- **Caddy:** входит в основной `docker-compose.prod.yml` (сервис `caddy`), отдельный caddytest-проект упразднён
- **Сертификаты:** Caddy получает их автоматически от Let's Encrypt; хранятся в volume `caddy_data`
- **Домен:** `sctrading.ru` → DNS указывает на 161.104.44.231

## Архитектура сети (важно для любого проекта с Caddy + Docker)
Все сервисы в одном compose-стеке → одна Docker-сеть. Caddy проксирует по **именам сервисов**, а не `localhost`:
```
Интернет → Caddy:443 → backend:8000 (API)
                      → frontend:80  (React/nginx)
```
- `backend` и `frontend` **не публикуют порты** наружу — только Caddy торчит в интернет (80/443)
- В Caddyfile: `reverse_proxy backend:8000` и `reverse_proxy frontend:80`, **не** `localhost:8000/3000`
- `localhost` внутри Docker-контейнера — это сам контейнер, **не** хост-машина

## Накатить обновление кода
```bash
cd /home/evgen/app && git pull
docker compose -f docker-compose.prod.yml build --no-cache backend frontend
docker compose -f docker-compose.prod.yml up -d
```
Если были изменения в моделях — применить миграции:
```bash
docker compose -f docker-compose.prod.yml exec backend alembic upgrade head
```
> **Внимание:** команда выше пересобирает только `backend` и `frontend`. `worker`, `scheduler` и `telegram_bot` — отдельные образы (`app-worker`, `app-scheduler`, `app-telegram_bot`) и **не подхватывают** изменения кода автоматически. Если правки затронули `app/tasks/*`, `app/services/*` (используется воркером/шедулером) или `telegram_bot/*` — пересобрать и их явно:
> ```bash
> docker compose -f docker-compose.prod.yml build --no-cache worker scheduler telegram_bot
> docker compose -f docker-compose.prod.yml up -d
> ```

> **При переписанной git-истории** (например, после `git-filter-repo`) обычный `git pull` не сработает (история разошлась) — нужен `git fetch && git reset --hard origin/main`.

## Caddy: применить новый Caddyfile без даунтайма
```bash
docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```
> Простой `docker compose restart caddy` не помогает — Caddy может загрузить старый autosave.json. Нужен именно `caddy reload`.

## Первый запуск после деплоя
1. Зарегистрировать первого пользователя на сайте
2. Выдать права и апрув через SQL:
```bash
docker compose -f /home/evgen/app/docker-compose.prod.yml exec postgres psql -U stalcraft -d stalcraft -c \
  "UPDATE users SET is_admin = true, is_approved = true WHERE username = 'mr_jonson_ponson';"
```
3. Заполнить каталог (2295 предметов из GitHub):
```bash
bash -c 'TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login -H "Content-Type: application/json" -d "{\"email\":\"nestarnarod@gmail.com\",\"password\":\"ПАРОЛЬ\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)[\"access_token\"])") && curl -s -X POST http://localhost:8000/api/v1/items/refresh-catalog -H "Authorization: Bearer $TOKEN"'
```

## Нюансы
- **Fish shell** — не поддерживает `VAR=$(...)`, используй `bash -c '...'` или `set VAR (...)` синтаксис fish
- **DB credentials:** user=`stalcraft`, db=`stalcraft` (не `scuser`/`scdb`)
- **Логин через API** — по `email`, не `username`
- **`version:` в docker-compose** — предупреждение `obsolete` безвредно
- **Апрув пользователя** требует двух полей: `is_admin = true` И `is_approved = true`
- **Каталог** не заполняется автоматически — нужен ручной вызов `/items/refresh-catalog` после первого деплоя
- **HTTP в 2026 — не вариант** — браузеры блокируют часть API (геолокация, SW), Telegram webhook требует HTTPS; Caddy с доменом выдаёт сертификат автоматически, правка Caddyfile — одна строка (`:80` → `domain.com`)
- **`telegram_bot` зависит от доступности `api.telegram.org` с сервера** — сеть с прод-сервера до Telegram нестабильна/флапает. При деплое 2026-07-08 после пересборки контейнер ~14 мин был в рестарт-лупе с `telegram.error.TimedOut` на инициализации (`get_me`), затем поднялся сам. Вся Telegram-рассылка (лоты + выброс) идёт через `telegram_bot` — при его недоступности уведомления не приходят. Если наблюдается рестарт-луп: дать боту время подняться, проверить сеть до Telegram (IPv4 vs IPv6, вероятен висящий IPv6-маршрут). Кандидат-фикс — `HTTPS_PROXY` для `telegram_bot` или форс IPv4 (см. пункт в `docs/NOTES.md`)
