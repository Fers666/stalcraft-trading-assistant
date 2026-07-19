from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse

from app.core.config import settings
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.watchlist import router as watchlist_router
from app.api.v1.endpoints.items import router as items_router
from app.api.v1.endpoints.lots import router as lots_router
from app.api.v1.endpoints.monitoring import router as monitoring_router
from app.api.v1.endpoints.settings import router as settings_router
from app.api.v1.endpoints.buy_sniper import router as buy_sniper_router
from app.api.v1.endpoints.admin import router as admin_router
from app.api.v1.endpoints.market_radar import router as market_radar_router
from app.api.v1.endpoints.telegram import router as telegram_router, register_webhook
from app.api.v1.endpoints.news import router as news_router
from app.api.v1.endpoints.emission import router as emission_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await register_webhook()
    yield


app = FastAPI(
    title="SZ Trading Assistant",
    version="0.1.0",
    description="Анализ аукциона STALZONE — рекомендации по покупкам и продажам",
    docs_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="/app/app/static"), name="static")

app.include_router(auth_router, prefix="/api/v1")
app.include_router(watchlist_router, prefix="/api/v1")
app.include_router(items_router, prefix="/api/v1")
app.include_router(lots_router, prefix="/api/v1")
app.include_router(monitoring_router, prefix="/api/v1")
app.include_router(settings_router, prefix="/api/v1")
app.include_router(buy_sniper_router, prefix="/api/v1")
app.include_router(admin_router, prefix="/api/v1")
app.include_router(market_radar_router, prefix="/api/v1")
app.include_router(telegram_router, prefix="/api/v1")
app.include_router(news_router, prefix="/api/v1")
app.include_router(emission_router, prefix="/api/v1")


@app.get("/docs", include_in_schema=False)
async def swagger_ui() -> HTMLResponse:
    html = """<!DOCTYPE html>
<html>
<head>
  <title>SZ Trading Assistant - Swagger UI</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" type="text/css" href="/static/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/static/swagger-ui-bundle.js"></script>
<script>
  SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.presets.base],
    layout: "BaseLayout",
    deepLinking: true,
  })
</script>
</body>
</html>"""
    return HTMLResponse(html)


@app.get("/health")
async def health():
    from app.core.rate_limiter import rate_limiter
    rl_status = await rate_limiter.get_status()
    return {"status": "ok", "rate_limiter": rl_status}
