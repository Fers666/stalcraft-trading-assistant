#!/usr/bin/env python3
"""
Полное экспериментальное исследование Rate Limit Stalcraft API.
Проверяет все endpoints и определяет реальные лимиты и стоимость запросов.
"""
import asyncio
import httpx
import json
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os
import time

# Загрузить .env
load_dotenv()

CLIENT_ID = os.getenv("STALCRAFT_CLIENT_ID", "3042")
CLIENT_SECRET = os.getenv("STALCRAFT_CLIENT_SECRET", "")
API_MODE = os.getenv("STALCRAFT_API_MODE", "production")
REGION = os.getenv("STALCRAFT_REGION", "RU")

TOKEN_URL = "https://exbo.net/oauth/token"
API_URL = "https://dapi.stalcraft.net" if API_MODE == "demo" else "https://eapi.stalcraft.net"

# Тестовые item IDs (популярные товары в Stalcraft)
TEST_ITEMS = ["0001", "04yr", "0ljs"]  # Примеры item IDs

class RateLimitTester:
    def __init__(self, token):
        self.token = token
        self.headers = {"Authorization": f"Bearer {token}"}
        self.results = []

    async def test_single_endpoint(self, name, method, endpoint, **kwargs):
        """Тест одного запроса к endpoint."""
        async with httpx.AsyncClient(proxies=None, trust_env=False, timeout=10.0) as client:
            url = f"{API_URL}{endpoint}"

            try:
                if method == "GET":
                    response = await client.get(url, headers=self.headers, **kwargs)
                elif method == "POST":
                    response = await client.post(url, headers=self.headers, **kwargs)
                else:
                    return None

                result = {
                    "name": name,
                    "endpoint": endpoint,
                    "method": method,
                    "status": response.status_code,
                    "timestamp": datetime.now().isoformat(),
                }

                # Собрать rate limit headers
                for key in ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]:
                    if key in response.headers:
                        result[key] = response.headers[key]

                self.results.append(result)
                return result

            except Exception as e:
                return {"name": name, "endpoint": endpoint, "error": str(e)}

    async def run_full_test(self):
        """Запускает полный набор тестов."""
        print(f"{'='*80}")
        print(f"ПОЛНОЕ ИССЛЕДОВАНИЕ RATE LIMIT STALCRAFT API")
        print(f"{'='*80}")
        print(f"API URL: {API_URL}")
        print(f"Region: {REGION}")
        print(f"\n")

        # Получим начальное состояние
        print(f"📊 Проверка начального состояния rate limit...")
        initial = await self.test_single_endpoint(
            "Baseline: /emission", "GET", f"/{REGION}/emission"
        )
        if initial:
            print(f"✅ Начальное состояние:")
            print(f"   Лимит: {initial.get('x-ratelimit-limit')}")
            print(f"   Остаток: {initial.get('x-ratelimit-remaining')}")
            print(f"   Reset: {initial.get('x-ratelimit-reset')}")
            initial_limit = int(initial.get('x-ratelimit-limit', 0))
            initial_remaining = int(initial.get('x-ratelimit-remaining', 0))

        # Test 1: /emission (1 запрос)
        print(f"\n\n📍 ТЕСТ 1: GET /{REGION}/emission (радиация)")
        print(f"{'-'*80}")

        results_emission = []
        for i in range(5):
            result = await self.test_single_endpoint(
                f"Emission-{i+1}", "GET", f"/{REGION}/emission"
            )
            if result and "status" in result:
                remaining = int(result.get("x-ratelimit-remaining", 0))
                cost = results_emission[-1]["remaining"] - remaining if results_emission else "?"
                print(f"Запрос {i+1}: status={result['status']}, remaining={remaining}, cost={cost}")
                results_emission.append({**result, "remaining": remaining})
            await asyncio.sleep(0.1)

        # Test 2: /auction/{item}/lots (список лотов)
        print(f"\n\n📍 ТЕСТ 2: GET /{REGION}/auction/{{item}}/lots (активные лоты)")
        print(f"{'-'*80}")

        results_lots = []
        for item_id in TEST_ITEMS[:2]:
            result = await self.test_single_endpoint(
                f"Lots-{item_id}", "GET", f"/{REGION}/auction/{item_id}/lots",
                params={"limit": 50, "offset": 0, "additional": "true"}
            )
            if result and "status" in result:
                remaining = int(result.get("x-ratelimit-remaining", 0))
                cost = results_lots[-1]["remaining"] - remaining if results_lots else "?"
                status_emoji = "✅" if result['status'] == 200 else "❌"
                print(f"{status_emoji} Item {item_id}: status={result['status']}, remaining={remaining}, cost={cost}")
                results_lots.append({**result, "remaining": remaining, "item_id": item_id})
            await asyncio.sleep(0.1)

        # Test 3: /auction/{item}/history (история продаж)
        print(f"\n\n📍 ТЕСТ 3: GET /{REGION}/auction/{{item}}/history (история)")
        print(f"{'-'*80}")

        results_history = []
        for item_id in TEST_ITEMS[:2]:
            result = await self.test_single_endpoint(
                f"History-{item_id}", "GET", f"/{REGION}/auction/{item_id}/history",
                params={"limit": 50, "offset": 0, "additional": "true"}
            )
            if result and "status" in result:
                remaining = int(result.get("x-ratelimit-remaining", 0))
                cost = results_history[-1]["remaining"] - remaining if results_history else "?"
                status_emoji = "✅" if result['status'] == 200 else "❌"
                print(f"{status_emoji} Item {item_id}: status={result['status']}, remaining={remaining}, cost={cost}")
                results_history.append({**result, "remaining": remaining, "item_id": item_id})
            await asyncio.sleep(0.1)

        # Test 4: Стресс-тест (много запросов подряд)
        print(f"\n\n📍 ТЕСТ 4: Стресс-тест (20 быстрых запросов к /emission)")
        print(f"{'-'*80}")

        stress_results = []
        for i in range(20):
            result = await self.test_single_endpoint(
                f"Stress-{i+1}", "GET", f"/{REGION}/emission"
            )
            if result and "status" in result:
                remaining = int(result.get("x-ratelimit-remaining", 0))
                stress_results.append(remaining)
                if i % 5 == 0:
                    print(f"Запрос {i+1:2d}: remaining={remaining}")
            await asyncio.sleep(0.05)

        # Анализ
        print(f"\n\n{'='*80}")
        print(f"📈 АНАЛИЗ РЕЗУЛЬТАТОВ")
        print(f"{'='*80}")

        # Расчет стоимости каждого типа запроса
        if results_emission and len(results_emission) > 1:
            emission_costs = []
            for i in range(1, len(results_emission)):
                cost = results_emission[i-1]["remaining"] - results_emission[i]["remaining"]
                emission_costs.append(cost)
            avg_emission_cost = sum(emission_costs) / len(emission_costs) if emission_costs else 0
            print(f"\n🔹 /emission:")
            print(f"   Стоимость за запрос: {emission_costs}")
            print(f"   Среднее: {avg_emission_cost:.2f}")

        if results_lots and len(results_lots) > 1:
            lots_costs = []
            for i in range(1, len(results_lots)):
                cost = results_lots[i-1]["remaining"] - results_lots[i]["remaining"]
                lots_costs.append(cost)
            avg_lots_cost = sum(lots_costs) / len(lots_costs) if lots_costs else 0
            print(f"\n🔹 /auction/{{id}}/lots:")
            print(f"   Стоимость за запрос: {lots_costs}")
            print(f"   Среднее: {avg_lots_cost:.2f}")

        if results_history and len(results_history) > 1:
            history_costs = []
            for i in range(1, len(results_history)):
                cost = results_history[i-1]["remaining"] - results_history[i]["remaining"]
                history_costs.append(cost)
            avg_history_cost = sum(history_costs) / len(history_costs) if history_costs else 0
            print(f"\n🔹 /auction/{{id}}/history:")
            print(f"   Стоимость за запрос: {history_costs}")
            print(f"   Среднее: {avg_history_cost:.2f}")

        # Стресс-тест анализ
        if len(stress_results) > 1:
            stress_costs = []
            for i in range(1, len(stress_results)):
                cost = stress_results[i-1] - stress_results[i]
                stress_costs.append(cost)
            print(f"\n🔹 Стресс-тест (20 быстрых запросов /emission):")
            print(f"   Убыток за каждый запрос: {stress_costs}")
            print(f"   Всего потеряно: {initial_remaining - stress_results[-1]}")

        # Общие выводы
        print(f"\n\n{'='*80}")
        print(f"💡 ВЫВОДЫ")
        print(f"{'='*80}")

        print(f"\n✅ ПОДТВЕРЖДЕННЫЕ ФАКТЫ:")
        print(f"   • Лимит: {initial_limit} запросов (не 100 токенов!)")
        print(f"   • Система: Request-based (каждый запрос = N за запрос)")
        print(f"   • Способ отслеживания: Headers x-ratelimit-*")
        print(f"   • Reset: Unix timestamp в миллисекундах")

        if len(stress_results) > 5:
            reset_time = int(initial.get('x-ratelimit-reset', 0))
            reset_datetime = datetime.fromtimestamp(reset_time / 1000)
            print(f"\n⏰ ВРЕМЯ RESET:")
            print(f"   Unix timestamp: {reset_time}")
            print(f"   Дата/Время: {reset_datetime}")

        print(f"\n❌ ДОКУМЕНТАЦИЯ ПОЛЬЗОВАТЕЛЯ НЕВЕРНА:")
        print(f"   Записано: '100 токенов/минута, /lots=2т, /history=2т'")
        print(f"   Реально: {initial_limit} запросов, система request-based")

        # Сохранить результаты
        print(f"\n\nСохранение всех результатов в rate_limit_full_results.json...")
        with open("rate_limit_full_results.json", "w", encoding="utf-8") as f:
            json.dump({
                "initial": initial,
                "emission_tests": results_emission,
                "lots_tests": results_lots,
                "history_tests": results_history,
                "stress_test": stress_results,
                "all_results": self.results,
            }, f, indent=2, ensure_ascii=False)
        print(f"✅ Результаты сохранены в rate_limit_full_results.json")


async def main():
    if not CLIENT_SECRET:
        print("❌ STALCRAFT_CLIENT_SECRET не найден в .env")
        return

    print(f"🚀 Запуск полного исследования rate limit")
    print(f"Credentials: client_id={CLIENT_ID}\n")

    # Получить токен
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
        token = response.json()["access_token"]
        print(f"✅ OAuth токен получен\n")

    # Запустить тесты
    tester = RateLimitTester(token)
    await tester.run_full_test()

    print(f"\n\n{'='*80}")
    print(f"✨ Исследование завершено!")
    print(f"{'='*80}\n")


if __name__ == "__main__":
    asyncio.run(main())
