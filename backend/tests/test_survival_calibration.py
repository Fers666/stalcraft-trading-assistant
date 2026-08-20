"""
Сверка публикуемых вероятностей с фактом (шаг 6, P1-7).

Проверяется то, на чём эта задача может тихо стать бесполезной:
- проверочное окно не должно пересекаться с обучающим (иначе таблица
  проверяет сама себя и всегда «сходится»);
- в выборку не должны попадать наблюдения, чья судьба на горизонте ещё не
  определена (иначе останутся одни быстрые — ошибка «метрика по выжившим»);
- знак ошибки обязан читаться однозначно.
"""

import pytest

from app.services.analytics.survival import (
    CALIBRATION_MATURITY_HOURS, MIN_CALIBRATION_N, _CALIB_SQL, _EVALUABLE,
)


def test_calibration_window_starts_after_training():
    """
    Окно проверки открывается моментом обучения (computed_at действующей
    таблицы). Пересечение периодов превратило бы калибровку в подгонку: кривая
    сверялась бы с данными, на которых её и построили.
    """
    assert "first_seen_at >= :window_from" in _CALIB_SQL


def test_only_determinate_observations_are_counted():
    """
    Наблюдение идёт в сверку, только если его судьба на горизонте определена:
    дожил до H у нас на глазах либо ушёл с рынка, И прошло достаточно времени,
    чтобы это стало известно.

    Без условия зрелости выборка наполняется одними быстрыми: лот, проданный за
    час, закрывается через два и попадает в неё, а его сосед, висящий вторые
    сутки, — нет. Ровно та ошибка, что уже стоила знаменателя самой кривой.
    """
    assert "outcome IS NOT NULL OR life_h >= h.horizon_h" in _EVALUABLE
    # CAST — не косметика: без него asyncpg не выводит тип параметра и запрос
    # падает на проде («timestamp with time zone <= interval»). Проверяется
    # здесь, потому что исполнением в тестах база не поднимается.
    assert "first_seen_at <= CAST(:now AS timestamptz) - make_interval" in _EVALUABLE
    assert "hours => h.horizon_h + CAST(:maturity AS int)" in _EVALUABLE
    assert CALIBRATION_MATURITY_HOURS >= 2   # задержка резолвера


def test_calibration_sql_is_fully_expanded():
    """Незаменённый плейсхолдер означал бы синтаксическую ошибку на проде."""
    for placeholder in ("{evaluable}", "{class_case}", "{known}"):
        assert placeholder not in _CALIB_SQL
    # bucket_case и availability подставляются на вызове — они должны остаться
    assert "{bucket_case}" in _CALIB_SQL
    assert "{availability}" in _CALIB_SQL


def test_thin_strata_are_not_reported():
    """
    Порог обязателен: ошибка в 10 п.п. на выборке в полсотни лотов неотличима
    от случайности (полуширина 95%-интервала там ~14 п.п.), и такая строка
    создавала бы ложную тревогу.
    """
    assert MIN_CALIBRATION_N >= 150


def test_error_sign_is_documented_as_dangerous_direction():
    """
    error_pp = realized - predicted. Отрицательное значит «обещали больше, чем
    вышло» — ошибка в сторону, опасную для пользователя. Направление зафиксиро-
    вано тестом, потому что перепутать знак здесь ничего не стоит, а читаться
    таблица будет годами.
    """
    predicted, realized = 73.68, 50.09      # реальные числа замера 2026-08-19
    error_pp = round(realized - predicted, 2)
    assert error_pp < 0
    assert error_pp == pytest.approx(-23.59, abs=0.01)


def test_short_window_is_refused():
    """
    Окно короче суток измеряет время суток, а не кривую: продажи идут в
    36-40 % в ночные часы против 54-57 % утром. Проверено на себе — ручной
    прогон через 5.5 ч после пересчёта дал среднюю ошибку -16.25 п.п. против
    -8.2 на полных сутках, и вся разница была от попадания окна в ночной
    провал. Такая строка в таблице хуже отсутствующей: она выглядит как
    сломанная кривая.
    """
    from app.services.analytics.survival import MIN_CALIBRATION_WINDOW_HOURS

    assert MIN_CALIBRATION_WINDOW_HOURS >= 20


# ─── Защита от техработ на стороне игры ──────────────────────────────────────

def test_market_blackout_threshold_is_short_enough_to_catch_outage():
    """
    Резолвер обязан отличать «лот исчез» от «исчез весь аукцион».

    2026-08-19 на время техработ API отвечал 200 OK, но с total=0 по всем
    предметам. Лоты «пропали», и резолвер закрыл 16 238 наблюдений как
    withdrawn — при норме в три-четыре сотни за час. Эти строки попали бы в
    знаменатель кривой как «не продались» и просадили бы все страты на две
    недели, пока не вышли бы из окна выборки.

    Порог должен срабатывать заметно раньше LOT_OBS_RESOLVE_DELAY_HOURS,
    иначе первые закрытия успеют пройти до того, как защита сработает.
    """
    from app.tasks.feed_collector import (
        LOT_OBS_RESOLVE_DELAY_HOURS, MARKET_DARK_MINUTES,
    )

    assert MARKET_DARK_MINUTES < LOT_OBS_RESOLVE_DELAY_HOURS * 60
    # Обход ленты занимает единицы минут — порог не должен ловить норму
    assert MARKET_DARK_MINUTES >= 10


def test_blackout_observations_leave_the_population_entirely():
    """
    Лот, пропавший вместе со всем рынком, должен ВЫПАСТЬ из выборки, а не
    получить метку.

    Первая версия защиты лишь запрещала резолв во время темноты, и этого не
    хватило: 2026-08-19, как только аукцион вернулся, те же 14 463 лота были
    закрыты как withdrawn — на рынок они уже не вернулись. Отсрочка на семь
    часов, а не решение.

    Метка тут не спасает: любой не-NULL outcome заводит строку в знаменатель
    (n_at_risk считает `outcome IS NOT NULL OR life_h >= H`) и никогда в
    числитель, то есть тихо просаживает вероятность по всем стратам.
    """
    from app.services.analytics.survival import _AGG_SQL, _CALIB_SQL

    for sql in (_AGG_SQL, _CALIB_SQL):
        assert "outcome IS NULL OR outcome <> 'blackout'" in sql


def test_blackout_detection_needs_no_stored_intervals():
    """
    Признак «пропал вместе с рынком» выводится из самих наблюдений: если после
    последнего показа лота ни один лот не наблюдался ещё MARKET_DARK_MINUTES,
    замолчал аукцион целиком. Хранить интервалы недоступности не нужно —
    отдельное состояние рассинхронизировалось бы с фактом.
    """
    import inspect
    from app.tasks import feed_collector

    src = inspect.getsource(feed_collector.blackout_orphans)
    assert "NOT EXISTS" in src
    assert "make_interval(mins => CAST(:dark AS int))" in src

    # Округление до минуты обязательно: строки ОДНОГО прохода различаются
    # секундами. Без него они ссылались бы друг на друга («лот в 06:22:10 видит
    # активность в 06:22:50»), и осиротевшим не признавался бы никто — ровно
    # так первая версия правила вернула 0 совпадений на реальной аварии.
    assert "date_trunc('minute', last_seen_at)" in src

    # Хвост нельзя считать тишиной: у самой свежей минуты «ничего после» всегда.
    assert "CAST(:now AS timestamptz)" in src

    # Окно неопределённости — полный круг обхода назад от момента тишины: лот
    # мог просто не попасть в последний проход перед остановкой.
    assert "CAST(:cycle AS int)" in src
    assert feed_collector.FEED_FULL_CYCLE_MINUTES >= 13


def test_frozen_market_is_detected_by_new_lots_not_by_visible_lots():
    """
    Заморозку рынка нельзя поймать по last_seen_at — только по first_seen_at.

    2026-08-19, через несколько часов после техработ, /lots начал отдавать
    снимок, застывший в 13:09 МСК: те же 297 лотов, бесконечно «живые».
    /history при этом работал — по одному «Атому» (wg53) прошло 186 сделок за
    10.8 часа, а новых лотов в /lots не появилось ни одного. Продажа без лота
    в книге невозможна, значит книга была недостоверна.

    MARKET_DARK_MINUTES смотрит на момент последнего показа ЛЮБОГО лота, а
    замороженные лоты мы исправно видели каждый цикл: сторож молчал все
    10.8 часа. Перестаёт расти при заморозке только одна величина — момент появления
    последнего НОВОГО лота.
    """
    import ast, inspect
    from app.tasks import feed_collector

    # Докстринг разбирает обе величины, поэтому сверяться надо с телом функции.
    fn = ast.parse(inspect.getsource(feed_collector.market_frozen_for)).body[0]
    if isinstance(fn.body[0], ast.Expr) and isinstance(fn.body[0].value, ast.Constant):
        fn.body.pop(0)
    code = ast.unparse(fn)

    assert "first_seen_at" in code
    assert "last_seen_at" not in code


def test_frozen_threshold_survives_a_slow_night_but_beats_the_resolver():
    """
    Порог заморозки: выше трёх полных кругов обхода и ниже задержки резолва.

    Снизу: в норме по рынку появляется минимум ~4 новых лота в минуту (ночной
    минимум — 245 лотов за час). Три круга подряд без единого нового лота
    случайно не случаются, а один-два круга — вполне (парковка предметов,
    перекос очереди).

    Сверху: резолвер закрывает наблюдение через LOT_OBS_RESOLVE_DELAY_HOURS
    после последнего показа. Сторож обязан сработать раньше, иначе первые
    строки успеют уйти в withdrawn до того, как защита включится.
    """
    from app.tasks.feed_collector import (
        FEED_FULL_CYCLE_MINUTES, LOT_OBS_RESOLVE_DELAY_HOURS,
        MARKET_FROZEN_MINUTES,
    )

    assert MARKET_FROZEN_MINUTES >= 3 * FEED_FULL_CYCLE_MINUTES
    assert MARKET_FROZEN_MINUTES < LOT_OBS_RESOLVE_DELAY_HOURS * 60


def test_frozen_guard_runs_only_when_lots_are_visible():
    """
    Заморозка проверяется ПОСЛЕ темноты и только если темноты нет.

    Темнота — частный случай отсутствия новых лотов, но обрабатывается она
    аккуратнее: blackout_orphans закрывает точечно тех, кто пропал перед
    тишиной, а не всю открытую когорту. Если бы порядок был обратным, долгий
    блэкаут выводил бы из выборки все живые наблюдения вместо нескольких сотен.
    """
    import inspect
    from app.tasks import feed_collector

    src = inspect.getsource(feed_collector.resolve_lot_observations)
    assert src.index("market_dark_for") < src.index("market_frozen_for")
    # Резолв во время заморозки не идёт: выход раньше _resolve_observations
    assert src.index("market_frozen_for") < src.index("_resolve_observations")
    assert '"skipped": "market_frozen"' in src


def test_frozen_cohort_never_overwrites_a_decided_outcome():
    """
    Пометка когорты трогает только живые и ещё не закрытые наблюдения.

    Без фильтра по outcome заморозка переписала бы уже посчитанные sold /
    expired задним числом, то есть уничтожила бы ровно те данные, ради
    сохранности которых сторож и заводится. Строки snapshot трогать нельзя по
    отдельной причине: их NULL в outcome — намеренное цензурирование.
    """
    import inspect
    from app.tasks import feed_collector

    src = inspect.getsource(feed_collector.blackout_frozen_cohort)
    assert "outcome.is_(None)" in src
    assert "LOT_OBS_SOURCE_LIVE" in src
    assert "LOT_OBS_OUTCOME_BLACKOUT" in src


def test_frozen_cohort_spares_lots_that_vanished_before_the_freeze():
    """
    Пометка ограничена теми, кого кормит застывший снимок.

    Граница — момент появления последнего настоящего нового лота. Наблюдения,
    исчезнувшие РАНЬШЕ неё, пропали при живом рынке: это обычные исходы, и
    отбирать их у резолвера незачем. Без границы заморозка списывала бы в
    blackout ещё и всё, что накопилось за LOT_OBS_RESOLVE_DELAY_HOURS до неё, —
    то есть уничтожала бы валидные данные ради защиты от невалидных.
    """
    import inspect
    from app.tasks import feed_collector

    src = inspect.getsource(feed_collector.blackout_frozen_cohort)
    assert "last_seen_at >= frozen_since" in src

    # Граница обязана вычисляться из самого признака, а не задаваться отдельно
    task = inspect.getsource(feed_collector.resolve_lot_observations)
    assert "frozen_since = now - timedelta(minutes=frozen_for)" in task
