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
