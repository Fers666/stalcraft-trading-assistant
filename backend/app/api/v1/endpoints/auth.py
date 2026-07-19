from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, EmailStr

from app.db.session import get_db
from app.models.models import User, UserSettings, RegistrationSettings
from app.core.security import hash_password, verify_password, create_access_token, create_refresh_token, decode_token
from app.core.dependencies import get_current_user
from app.core.tiers import get_tier_limits

router = APIRouter(prefix="/auth", tags=["Auth"])


class RegisterRequest(BaseModel):
    username: str
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RegisterResponse(BaseModel):
    message: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    telegram_username: str | None
    is_admin: bool
    is_approved: bool
    tier: str
    tier_expires_at: datetime | None
    # Вычисляемые лимиты тарифа — единый источник истины (backend/app/core/tiers.py),
    # фронт не дублирует константы.
    watchlist_limit: int | None
    telegram_notifications: bool
    stats_windows: tuple[str, ...]
    auction_access: bool
    buy_sniper_access: bool
    buy_sniper_notifications: bool
    has_market_radar_addon: bool
    favorites_limit_override: int | None

    class Config:
        from_attributes = True

    @classmethod
    def from_user(cls, user: User) -> "UserResponse":
        limits = get_tier_limits(user)
        return cls(
            id=user.id,
            username=user.username,
            email=user.email,
            telegram_username=user.telegram_username,
            is_admin=user.is_admin,
            is_approved=user.is_approved,
            tier=user.tier,
            tier_expires_at=user.tier_expires_at,
            watchlist_limit=limits.watchlist_limit,
            telegram_notifications=limits.telegram_notifications,
            stats_windows=limits.stats_windows,
            auction_access=limits.auction_access,
            buy_sniper_access=limits.buy_sniper_access,
            buy_sniper_notifications=limits.buy_sniper_notifications,
            has_market_radar_addon=user.has_market_radar_addon,
            favorites_limit_override=user.favorites_limit_override,
        )


@router.post("/register", response_model=RegisterResponse, status_code=201)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(
        select(User).where((User.email == payload.email) | (User.username == payload.username))
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Email or username already taken")

    reg_settings = (await db.execute(
        select(RegistrationSettings).where(RegistrationSettings.id == 1)
    )).scalar_one_or_none()
    auto_approve = reg_settings.auto_approve_enabled if reg_settings else False

    user = User(
        username=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
        is_approved=auto_approve,
        tier=(reg_settings.default_tier if auto_approve and reg_settings else "base"),
        tier_expires_at=(
            datetime.now(timezone.utc) + timedelta(days=reg_settings.default_tier_duration_days)
            if auto_approve and reg_settings and reg_settings.default_tier_duration_days
            else None
        ),
    )
    db.add(user)
    await db.flush()

    db.add(UserSettings(user_id=user.id))
    await db.commit()

    msg = "Регистрация успешна." if auto_approve else "Регистрация успешна. Ожидайте подтверждения администратора."
    return RegisterResponse(message=msg)


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_approved:
        raise HTTPException(status_code=403, detail="Account pending admin approval")

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    user_id = decode_token(payload.refresh_token, expected_type="refresh")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user or not user.is_approved or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or not approved")

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return UserResponse.from_user(current_user)
