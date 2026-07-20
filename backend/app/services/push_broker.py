"""Публикация событий уведомлений в RabbitMQ — продюсер для push_service.

Продюсер — Celery-коллектор (tasks/collectors.py). Каждая Celery-таска создаёт
свой event loop (run_async), поэтому соединение НЕ кэшируется между тасками:
канал открывается на батч (как redis_client) и закрывается в finally.

Публикация best-effort: сбой RabbitMQ НЕ должен ломать сбор данных — Telegram
работает независимо через Redis, а push — дополнительный канал. Поэтому open/
publish/close глотают исключения и логируют предупреждение.

Событие лёгкое: {type, user_id, item_id, region, quality_filter, enchant_filter,
payload}. Consumer (push_service) сам решает, кто подписан, проверяет тариф и
рассылает — продюсер о подписках ничего не знает.
"""
import json
import logging

logger = logging.getLogger(__name__)

EXCHANGE_NAME = "push.events"
ROUTING_KEY = "push"


async def open_channel():
    """Подключается к RabbitMQ и декларирует durable direct-exchange push.events.

    Возвращает (connection, exchange) либо (None, None) при сбое — вызывающий код
    продолжает работу без публикации push-событий.
    """
    import aio_pika
    from app.core.config import settings
    try:
        connection = await aio_pika.connect_robust(settings.rabbitmq_url)
        channel = await connection.channel()
        exchange = await channel.declare_exchange(
            EXCHANGE_NAME, aio_pika.ExchangeType.DIRECT, durable=True
        )
        return connection, exchange
    except Exception as e:
        logger.warning(f"push_broker: не удалось подключиться к RabbitMQ: {e}")
        return None, None


async def publish_event(exchange, event: dict) -> None:
    """Публикует одно событие. No-op при exchange=None. Ошибки не пробрасываются."""
    if exchange is None:
        return
    import aio_pika
    try:
        await exchange.publish(
            aio_pika.Message(
                body=json.dumps(event).encode(),
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                content_type="application/json",
            ),
            routing_key=ROUTING_KEY,
        )
    except Exception as e:
        logger.warning(f"push_broker: publish failed ({event.get('type')}): {e}")


async def close_channel(connection) -> None:
    """Закрывает соединение (awaited в рамках живого loop — без утечки сокетов)."""
    if connection is None:
        return
    try:
        await connection.close()
    except Exception:
        pass
