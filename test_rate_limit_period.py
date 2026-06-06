#!/usr/bin/env python3
"""
Определяет период rate limit (1 час? 15 минут? 1 день?).
Отслеживает reset и вычисляет интервал.
"""
import asyncio
import httpx
import json
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os

load_dotenv()

CLIENT_ID = os.getenv("STALCRAFT_CLIENT_ID", "3042")
CLIENT_SECRET = os.getenv("STALCRAFT_CLIENT_SECRET", "")
API_MODE = os.getenv("STALCRAFT_API_MODE", "production")
REGION = os.getenv("STALCRAFT_REGION", "RU")

TOKEN_URL = "https://exbo.net/oauth/token"
API_URL = "https://dapi.stalcraft.net" if API_MODE == "demo" else "https://eapi.stalcraft.net"


async def get_token():
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
        return response.json()["access_token"]


async def check_rate_limit():
    token = await get_token()
    headers = {"Authorization": f"Bearer {token}"}

    observations = []

    print(f"{'='*80}")
    print(f"ОПРЕДЕЛЕНИЕ ПЕРИОДА RATE LIMIT")
    print(f"{'='*80}\n")

    for i in range(30):  # Проверяем 30 раз (каждые 2 сек = 60 сек = 1 минута)
        async with httpx.AsyncClient(proxies=None, trust_env=False, timeout=10) as client:
            try:
                response = await client.get(
                    f"{API_URL}/{REGION}/emission",
                    headers=headers,
                )

                timestamp_now = datetime.now()
                limit = int(response.headers.get("x-ratelimit-limit", 0))
                remaining = int(response.headers.get("x-ratelimit-remaining", 0))
                reset_ms = int(response.headers.get("x-ratelimit-reset", 0))

                reset_dt = datetime.fromtimestamp(reset_ms / 1000)
                time_to_reset = reset_dt - timestamp_now

                obs = {
                    "iteration": i + 1,
                    "timestamp": timestamp_now.isoformat(),
                    "limit": limit,
                    "remaining": remaining,
                    "used": limit - remaining,
                    "reset_timestamp_ms": reset_ms,
                    "reset_datetime": reset_dt.isoformat(),
                    "seconds_to_reset": time_to_reset.total_seconds(),
                }
                observations.append(obs)

                emoji = "📍" if i == 0 else "⏱️"
                print(
                    f"{emoji} Итерация {i+1:2d}: remaining={remaining:3d}, "
                    f"used={limit - remaining:3d}, reset через {time_to_reset.total_seconds():6.1f} сек"
                )

                # Если reset время изменилось - это новый цикл!
                if i > 0 and observations[i-1]["reset_timestamp_ms"] != reset_ms:
                    print(f"\n🔔 ДЕТЕКТИРОВАН НОВЫЙ ЦИКЛ RATE LIMIT!")
                    print(f"   Предыдущий reset: {observations[i-1]['reset_datetime']}")
                    print(f"   Новый reset: {reset_dt.isoformat()}")
                    old_reset = datetime.fromisoformat(observations[i-1]["reset_datetime"])
                    period = (reset_dt - old_reset).total_seconds()
                    print(f"   Период: {period} секунд = {period/60:.2f} минут = {period/3600:.2f} часов")

                await asyncio.sleep(2)  # Ждем 2 сек перед следующей проверкой

            except Exception as e:
                print(f"❌ Ошибка на итерации {i+1}: {e}")
                await asyncio.sleep(2)

    # Анализ
    print(f"\n\n{'='*80}")
    print(f"📈 АНАЛИЗ")
    print(f"{'='*80}\n")

    if observations:
        first = observations[0]
        last = observations[-1]

        print(f"Первое наблюдение: {first['timestamp']}")
        print(f"   Limit: {first['limit']}, Remaining: {first['remaining']}")
        print(f"   Reset: {first['reset_datetime']}")

        print(f"\nПоследнее наблюдение: {last['timestamp']}")
        print(f"   Limit: {last['limit']}, Remaining: {last['remaining']}")
        print(f"   Reset: {last['reset_datetime']}")

        # Проверить изменилось ли reset время
        reset_times = set(obs["reset_timestamp_ms"] for obs in observations)
        print(f"\nУникальные время reset: {len(reset_times)}")

        if len(reset_times) == 1:
            print(f"⚠️ Reset время НЕ изменилось за все наблюдения ({len(observations)} итераций / {len(observations)*2} секунд)")
            print(f"   Период reset БОЛЬШЕ чем {len(observations)*2} секунд")
        else:
            print(f"✅ Детектировано {len(reset_times)} разных время reset")

        # Проверить как меняется remaining
        remaining_changes = [
            (observations[i]["remaining"], observations[i+1]["remaining"])
            for i in range(len(observations)-1)
        ]

        all_same = all(r[0] == r[1] for r in remaining_changes)
        if all_same:
            print(f"\n💾 Remaining НЕ МЕНЯЛСЯ за все наблюдения - лимит пока не обнуляется")
        else:
            print(f"\n⚠️ Remaining менялся - используются запросы из лимита")

        # Сохранить результаты
        with open("rate_limit_period_results.json", "w") as f:
            json.dump({
                "observations": observations,
                "analysis": {
                    "total_iterations": len(observations),
                    "duration_seconds": (len(observations) - 1) * 2,
                    "unique_reset_times": len(reset_times),
                }
            }, f, indent=2)

        print(f"\n✅ Результаты сохранены в rate_limit_period_results.json")


if __name__ == "__main__":
    print("🚀 Запуск отслеживания rate limit периода\n")
    asyncio.run(check_rate_limit())
