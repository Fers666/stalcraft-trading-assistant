from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.watchlist import router as watchlist_router
from app.api.v1.endpoints.items import router as items_router
from app.api.v1.endpoints.lots import router as lots_router
from app.api.v1.endpoints.monitoring import router as monitoring_router
from app.api.v1.endpoints.settings import router as settings_router
from app.api.v1.endpoints.inventory import router as inventory_router

app = FastAPI(
    title="Stalcraft Trading Assistant",
    version="0.1.0",
    description="Анализ аукциона Stalcraft X — рекомендации по покупкам и продажам",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api/v1")
app.include_router(watchlist_router, prefix="/api/v1")
app.include_router(items_router, prefix="/api/v1")
app.include_router(lots_router, prefix="/api/v1")
app.include_router(monitoring_router, prefix="/api/v1")
app.include_router(settings_router, prefix="/api/v1")
app.include_router(inventory_router, prefix="/api/v1")


@app.get("/health")
async def health():
    from app.core.rate_limiter import rate_limiter
    rl_status = await rate_limiter.get_status()
    return {"status": "ok", "rate_limiter": rl_status}
