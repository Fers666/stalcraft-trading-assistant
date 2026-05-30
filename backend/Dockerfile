FROM python:3.12-slim

# Копируем uv из официального образа
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# gcc нужен для компиляции некоторых C-расширений (asyncpg, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

# Устанавливаем зависимости отдельным слоем — кешируется если pyproject.toml не менялся
COPY requirements.txt pyproject.toml ./
ENV UV_HTTP_TIMEOUT=120
RUN uv pip install --system --no-cache -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
