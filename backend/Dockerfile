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

# Swagger UI — скачиваем из npm registry (без CDN, работает в любом регионе)
RUN python3 -c "\
import urllib.request, tarfile, os, io; \
os.makedirs('app/static', exist_ok=True); \
data = urllib.request.urlopen('https://registry.npmjs.org/swagger-ui-dist/-/swagger-ui-dist-5.17.14.tgz', timeout=60).read(); \
tar = tarfile.open(fileobj=io.BytesIO(data)); \
[open(f'app/static/{os.path.basename(m.name)}', 'wb').write(tar.extractfile(m).read()) \
 for m in tar.getmembers() if m.name.endswith(('swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'swagger-ui.css'))]"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
