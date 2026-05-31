from contextlib import asynccontextmanager
from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool
from app.core.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)

@event.listens_for(engine.sync_engine, "connect")
def set_timezone(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("SET TIMEZONE TO 'Europe/Moscow'")
    cursor.close()

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    """FastAPI dependency."""
    async with AsyncSessionLocal() as session:
        yield session


@asynccontextmanager
async def get_db_session():
    """Async context manager для Celery tasks (с общим пулом соединений)."""
    async with AsyncSessionLocal() as session:
        yield session


@asynccontextmanager
async def get_celery_db_session():
    """
    Async context manager для Celery tasks с NullPool.

    Создаёт отдельный движок без пула соединений — каждый вызов открывает
    и сразу закрывает соединение. Это исключает конфликты event loop,
    возникающие когда Celery-воркер создаёт новый loop для каждой задачи,
    а shared engine привязан к старому.
    """
    celery_engine = create_async_engine(
        settings.database_url,
        echo=settings.debug,
        poolclass=NullPool,
    )

    @event.listens_for(celery_engine.sync_engine, "connect")
    def set_tz(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("SET TIMEZONE TO 'Europe/Moscow'")
        cursor.close()

    session_maker = async_sessionmaker(celery_engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            yield session
    finally:
        await celery_engine.dispose()
