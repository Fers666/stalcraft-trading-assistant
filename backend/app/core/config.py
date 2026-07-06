from pydantic_settings import BaseSettings
from typing import Literal, List


class Settings(BaseSettings):
    # Stalcraft API
    stalcraft_client_id: str = ""
    stalcraft_client_secret: str = ""
    stalcraft_api_mode: Literal["demo", "production"] = "production"
    stalcraft_region: str = "RU"

    # Database
    database_url: str

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Auth
    secret_key: str = "change_me"
    access_token_expire_minutes: int = 60
    refresh_token_expire_days: int = 30

    # Telegram
    telegram_bot_token: str = ""
    telegram_bot_username: str = "SC_TRADING_auc_bot"
    telegram_webhook_url: str = ""

    # App
    debug: bool = False
    cors_origins: str = "http://localhost:3000"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    @property
    def stalcraft_base_url(self) -> str:
        return "https://dapi.stalcraft.net" if self.stalcraft_api_mode == "demo" else "https://eapi.stalcraft.net"

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


settings = Settings()
