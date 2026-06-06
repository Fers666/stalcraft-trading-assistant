#!/usr/bin/env python3
"""
Экспериментальная проверка rate limit Stalcraft API.
Получает OAuth token и делает серию запросов, отслеживая поведение rate limit.
"""
import asyncio
import httpx
import json
from datetime import datetime
from dotenv import load_dotenv
import os

# Загрузить .env
load_dotenv()

CLIENT_ID = os.getenv("STALCRAFT_CLIENT_ID", "3042")
CLIENT_SECRET = os.getenv("STALCRAFT_CLIENT_SECRET", "")
API_MODE = os.getenv("STALCRAFT_API_MODE", "production")
REGION = os.getenv("STALCRAFT_REGION", "RU")

# URLs
TOKEN_URL = "https://exbo.net/oauth/token"
API_URL = "https://dapi.stalcraft.net" if API_MODE == "demo" else "https://eapi.stalcraft.net"

async def get_oauth_token():
    """Получить OAuth токен для API."""
    async with httpx.AsyncClient(proxies=None, trust_env=False) as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
            },
        )
        response.raise_for_status()
        data = response.json()
        print(f"✅ OAuth token получен")
        print(f"   Expires in: {data.get('expires_in')} сек")
        return data["access_token"]


async def test_rate_limit():
    """Тестирует rate limit делая серию запросов."""
    token = await get_oauth_token()

    print(f"\n{'='*70}")
    print(f"Тестирование Rate Limit API")
    print(f"{'='*70}")
    print(f"API Mode: {API_MODE}")
    print(f"Region: {REGION}")
    print(f"API URL: {API_URL}")

    headers = {"Authorization": f"Bearer {token}"}

    # Test 1: Single request to check response headers
    print(f"\n📊 Тест 1: Проверка headers в response")
    print(f"{'-'*70}")

    async with httpx.AsyncClient(proxies=None, trust_env=False) as client:
        response = await client.get(
            f"{API_URL}/{REGION}/emission",
            headers=headers,
        )

        print(f"Status: {response.status_code}")
        print(f"\nResponse Headers:")
        for key, value in response.headers.items():
            if "rate" in key.lower() or "limit" in key.lower() or "x-" in key.lower():
                print(f"  {key}: {value}")

        print(f"\nВсе headers:")
        for key, value in response.headers.items():
            print(f"  {key}: {value}")

        if response.status_code == 200:
            print(f"\n✅ API response OK")
            data = response.json()
            print(f"Emission data received: {json.dumps(data, indent=2)[:200]}...")

    # Test 2: Multiple rapid requests to detect rate limiting
    print(f"\n\n📊 Тест 2: Серия запросов для отслеживания rate limit")
    print(f"{'-'*70}")

    results = []
    async with httpx.AsyncClient(proxies=None, trust_env=False) as client:
        for i in range(1, 11):  # 10 запросов
            try:
                response = await client.get(
                    f"{API_URL}/{REGION}/emission",
                    headers=headers,
                )

                timestamp = datetime.now().isoformat(timespec='seconds')

                result = {
                    "request": i,
                    "timestamp": timestamp,
                    "status": response.status_code,
                    "headers": dict(response.headers),
                }

                # Собрать все rate limit related headers
                for key in response.headers:
                    if "rate" in key.lower() or "limit" in key.lower() or "ratelimit" in key.lower():
                        result[key] = response.headers[key]

                results.append(result)

                status_emoji = "✅" if response.status_code == 200 else "⚠️"
                print(f"{status_emoji} Запрос {i}: {response.status_code} @ {timestamp}")

                # Вывести rate limit headers если есть
                rate_headers = {k: v for k, v in response.headers.items()
                               if "rate" in k.lower() or "limit" in k.lower()}
                if rate_headers:
                    for k, v in rate_headers.items():
                        print(f"   {k}: {v}")

                if response.status_code == 429:
                    print(f"⚠️ Rate limit exceeded!")
                    break

                # Пауза между запросами
                await asyncio.sleep(0.1)

            except Exception as e:
                print(f"❌ Запрос {i}: {e}")

    # Сохранить результаты
    print(f"\n\n{'='*70}")
    print(f"Сохранение результатов в rate_limit_test_results.json")
    with open("rate_limit_test_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"✅ Результаты сохранены")

    # Анализ
    print(f"\n\n{'='*70}")
    print(f"📈 АНАЛИЗ РЕЗУЛЬТАТОВ")
    print(f"{'='*70}")

    success_count = sum(1 for r in results if r["status"] == 200)
    error_count = sum(1 for r in results if r["status"] != 200)

    print(f"Успешных запросов: {success_count}")
    print(f"Ошибок: {error_count}")

    if error_count > 0:
        errors = [r for r in results if r["status"] != 200]
        for err in errors:
            print(f"  Запрос {err['request']}: {err['status']}")

    # Вывести все найденные rate limit headers
    all_rate_headers = {}
    for r in results:
        for key, value in r.items():
            if "rate" in key.lower() or "limit" in key.lower():
                if key not in all_rate_headers:
                    all_rate_headers[key] = []
                all_rate_headers[key].append(value)

    if all_rate_headers:
        print(f"\n🔍 Найдены Rate Limit Headers:")
        for key, values in all_rate_headers.items():
            print(f"  {key}:")
            for val in values:
                print(f"    - {val}")
    else:
        print(f"\n⚠️ Rate limit headers НЕ найдены в response")

    print(f"\n\n{'='*70}")
    print(f"💡 ВЫВОД:")
    print(f"{'='*70}")
    print(f"Если rate limit headers отсутствуют - API не раскрывает эту информацию")
    print(f"Нужно проверять поведение API экспериментально (делать большие нагрузки)")
    print(f"или уточнить спецификацию у разработчиков EXBO")


if __name__ == "__main__":
    if not CLIENT_SECRET:
        print("❌ STALCRAFT_CLIENT_SECRET не найден в .env")
        exit(1)

    print(f"🚀 Запуск теста rate limit")
    print(f"Используемые credentials:")
    print(f"  CLIENT_ID: {CLIENT_ID}")
    print(f"  CLIENT_SECRET: {'*' * 20}")

    asyncio.run(test_rate_limit())
