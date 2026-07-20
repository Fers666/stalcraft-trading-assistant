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

## Web Push / RabbitMQ (первый деплой фичи, 2026-07-20)

Фича добавляет два новых сервиса (`rabbitmq`, `push_service`) и требует VAPID-ключи.
ТЗ — `docs/tasks/web-push-notifications.md`. Порядок первого деплоя:

1. **Сгенерировать ОТДЕЛЬНЫЕ прод-VAPID-ключи** (не переиспользовать локальные). Внутри backend-образа стоит `py-vapid`:
   ```bash
   docker compose -f docker-compose.prod.yml run --rm backend python - <<'PY'
   from cryptography.hazmat.primitives.asymmetric import ec
   from cryptography.hazmat.primitives import serialization
   import base64
   b=lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
   k=ec.generate_private_key(ec.SECP256R1())
   print("VAPID_PRIVATE_KEY="+b(k.private_numbers().private_value.to_bytes(32,'big')))
   print("VAPID_PUBLIC_KEY="+b(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)))
   PY
   ```
   Значения (+ `VAPID_SUBJECT=mailto:...`) вписать в прод `.env`. `VAPID_PRIVATE_KEY` — секрет, в git не коммитить.
2. **Пересобрать и поднять** (новые зависимости backend-образа + новые сервисы):
   ```bash
   docker compose -f docker-compose.prod.yml build --no-cache backend frontend worker push_service
   docker compose -f docker-compose.prod.yml up -d
   ```
   `push_service` переиспользует backend-образ; `worker` пересобрать обязательно (он публикует события).
3. **Применить миграцию** `0035` (таблица `push_subscriptions`):
   ```bash
   docker compose -f docker-compose.prod.yml exec backend alembic upgrade head
   ```
4. **Проверить:** `docker compose -f docker-compose.prod.yml ps` (rabbitmq healthy, push_service up),
   лог `push_service` = «запущен, слушаю push.notifications»,
   `curl -s https://sctrading.ru/api/v1/push/vapid-public-key` → ключ.

> **Безопасность:** RabbitMQ портов наружу не публикует (только внутри compose-сети), но креды по умолчанию `guest/guest`. Перед проколом наружу/при ужесточении — задать отдельного пользователя RabbitMQ и обновить `RABBITMQ_URL`. Management UI (15672) — только через SSH-туннель.
> **HTTPS обязателен** для web push и Service Worker — уже есть (Caddy + `sctrading.ru`).

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
