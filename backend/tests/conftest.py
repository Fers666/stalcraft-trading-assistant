"""Делает пакет `app` импортируемым независимо от того, откуда запущен pytest."""

import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Модули Celery-задач читают app.core.config.settings на уровне импорта, а
# DATABASE_URL — единственное обязательное поле Settings. Тесты к БД не ходят,
# значение нужно только чтобы импорт не падал валидацией вне docker-окружения.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
