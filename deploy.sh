#!/bin/bash
set -e

: "${STALCRAFT_CLIENT_ID:?Set STALCRAFT_CLIENT_ID before running deploy.sh}"
: "${STALCRAFT_CLIENT_SECRET:?Set STALCRAFT_CLIENT_SECRET before running deploy.sh}"
: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN before running deploy.sh}"

echo "=== Генерируем секреты ==="
PGPASS=$(openssl rand -hex 16)
SKEY=$(openssl rand -hex 32)

echo "=== Пишем .env ==="
cat > .env << ENVEOF
STALCRAFT_CLIENT_ID=${STALCRAFT_CLIENT_ID}
STALCRAFT_CLIENT_SECRET=${STALCRAFT_CLIENT_SECRET}
STALCRAFT_API_MODE=production
STALCRAFT_REGION=RU

POSTGRES_PASSWORD=${PGPASS}
DATABASE_URL=postgresql+asyncpg://stalcraft:${PGPASS}@postgres:5432/stalcraft
REDIS_URL=redis://redis:6379/0

SECRET_KEY=${SKEY}
ACCESS_TOKEN_EXPIRE_MINUTES=60
REFRESH_TOKEN_EXPIRE_DAYS=30

TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_BOT_USERNAME=SC_TRADING_auc_bot
TELEGRAM_WEBHOOK_URL=

DEBUG=false
CORS_ORIGINS=http://161.104.44.231
ENVEOF

echo "=== Настраиваем Caddy ==="
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

echo "=== Собираем и запускаем контейнеры ==="
docker compose -f docker-compose.prod.yml up -d --build

echo "=== Ждём старта БД (40 сек) ==="
sleep 40

echo "=== Применяем миграции ==="
docker compose -f docker-compose.prod.yml exec -T backend alembic upgrade head

echo "=== Готово! Статус контейнеров: ==="
docker compose -f docker-compose.prod.yml ps
