from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.dependencies import get_current_admin, get_current_user
from app.db.session import get_db
from app.models.models import News, User

router = APIRouter(prefix="/news", tags=["News"])

ALLOWED_TAGS = {"обновление", "тарифы", "техработы", "важно"}


# ─── Pydantic-схемы ───────────────────────────────────────────────────────────

class NewsCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    content: str = Field(..., min_length=1)
    tags: list[str] = []
    is_pinned: bool = False
    is_published: bool = True

    @validator("tags", each_item=True)
    def validate_tag(cls, v: str) -> str:
        if v not in ALLOWED_TAGS:
            raise ValueError(
                f"Недопустимый тег '{v}'. Допустимые теги: {sorted(ALLOWED_TAGS)}"
            )
        return v


class NewsUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=300)
    content: Optional[str] = Field(None, min_length=1)
    tags: Optional[list[str]] = None
    is_pinned: Optional[bool] = None
    is_published: Optional[bool] = None

    @validator("tags", each_item=True, pre=True, always=False)
    def validate_tag(cls, v: str) -> str:
        if v not in ALLOWED_TAGS:
            raise ValueError(
                f"Недопустимый тег '{v}'. Допустимые теги: {sorted(ALLOWED_TAGS)}"
            )
        return v


class NewsResponse(BaseModel):
    id: int
    author_id: Optional[int]
    author_username: Optional[str]
    title: str
    content: str
    tags: list[str]
    is_pinned: bool
    is_published: bool
    created_at: datetime
    updated_at: Optional[datetime]

    class Config:
        from_attributes = True


# ─── Вспомогательная функция ──────────────────────────────────────────────────

def _to_response(news: News) -> NewsResponse:
    return NewsResponse(
        id=news.id,
        author_id=news.author_id,
        author_username=news.author.username if news.author else None,
        title=news.title,
        content=news.content,
        tags=news.tags or [],
        is_pinned=news.is_pinned,
        is_published=news.is_published,
        created_at=news.created_at,
        updated_at=news.updated_at,
    )


_WITH_AUTHOR = selectinload(News.author)

# ─── Роуты ───────────────────────────────────────────────────────────────────

# ВАЖНО: /admin/all должен быть объявлен ДО /{news_id},
# иначе FastAPI трактует "admin" как числовой news_id и падает с 422.

@router.get("/admin/all", response_model=list[NewsResponse])
async def get_all_news_admin(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Все новости включая черновики (только для администраторов)."""
    result = await db.execute(
        select(News)
        .options(_WITH_AUTHOR)
        .order_by(News.is_pinned.desc(), News.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return [_to_response(n) for n in result.scalars().all()]


@router.get("/", response_model=list[NewsResponse])
async def get_published_news(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Список опубликованных новостей (для всех авторизованных пользователей)."""
    result = await db.execute(
        select(News)
        .options(_WITH_AUTHOR)
        .where(News.is_published == True)
        .order_by(News.is_pinned.desc(), News.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return [_to_response(n) for n in result.scalars().all()]


@router.get("/{news_id}", response_model=NewsResponse)
async def get_news_item(
    news_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Одна опубликованная новость по id."""
    result = await db.execute(
        select(News)
        .options(_WITH_AUTHOR)
        .where(News.id == news_id, News.is_published == True)
    )
    news = result.scalar_one_or_none()
    if not news:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Новость не найдена")
    return _to_response(news)


@router.post("/", response_model=NewsResponse, status_code=status.HTTP_201_CREATED)
async def create_news(
    payload: NewsCreate,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(get_current_admin),
):
    """Создать новость (только для администраторов)."""
    news = News(
        author_id=current_admin.id,
        title=payload.title,
        content=payload.content,
        tags=payload.tags,
        is_pinned=payload.is_pinned,
        is_published=payload.is_published,
    )
    db.add(news)
    await db.commit()
    await db.refresh(news)
    # Загружаем автора после refresh, чтобы заполнить author_username
    await db.refresh(news, attribute_names=["author"])
    return _to_response(news)


@router.put("/{news_id}", response_model=NewsResponse)
async def update_news(
    news_id: int,
    payload: NewsUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Частичное обновление новости (только переданные не-None поля)."""
    result = await db.execute(
        select(News).options(_WITH_AUTHOR).where(News.id == news_id)
    )
    news = result.scalar_one_or_none()
    if not news:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Новость не найдена")

    update_data = payload.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(news, field, value)

    await db.commit()
    await db.refresh(news)
    await db.refresh(news, attribute_names=["author"])
    return _to_response(news)


@router.delete("/{news_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_news(
    news_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Удалить новость (только для администраторов)."""
    result = await db.execute(select(News).where(News.id == news_id))
    news = result.scalar_one_or_none()
    if not news:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Новость не найдена")
    await db.delete(news)
    await db.commit()
