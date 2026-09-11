# Integration tests for the per-card content model: 20 sessions x 15 cards,
# no topics, one global session per day, 1 EazeScore per card. Hits a real
# Postgres (see test_score_events.py for why). Streak/session-cycling
# scenarios need multi-day fixtures, which record_card_result can't produce
# on its own (it always stamps created_at as "now") — those tests insert
# backdated rows directly via query(), at IST noon on the target day so
# results never land on the wrong side of a day boundary.
import uuid
from datetime import datetime, timedelta, timezone

from app.db.client import query
from app.repositories.card_results import (
    get_completed_sessions_count,
    get_ist_date_string,
    get_streak,
    get_today_session_state,
    record_card_result,
)
from app.repositories.score_events import get_score_for_user


def unique_id(prefix):
    return f"{prefix}-{uuid.uuid4()}"


def ist_date_n_days_ago(n):
    year, month, day = (int(part) for part in get_ist_date_string().split("-"))
    dt = datetime(year, month, day, tzinfo=timezone.utc) - timedelta(days=n)
    return dt.strftime("%Y-%m-%d")


# Backdates a row to IST-noon on the given day so it's unambiguously inside
# that IST calendar date regardless of the host machine's own timezone.
async def insert_backdated(eaze_user_id, *, session_number, card_number, is_correct, days_ago):
    await query(
        """INSERT INTO card_results (eaze_user_id, session_number, card_number, is_correct, created_at)
           VALUES (%s, %s, %s, %s, ((%s::date + time '12:00:00') AT TIME ZONE 'Asia/Kolkata'))""",
        [eaze_user_id, session_number, card_number, is_correct, ist_date_n_days_ago(days_ago)],
    )


async def complete_full_day(eaze_user_id, *, session_number=1, days_ago, cards_per_session=15):
    for card in range(1, cards_per_session + 1):
        await insert_backdated(
            eaze_user_id, session_number=session_number, card_number=card,
            is_correct=(card % 2 == 0), days_ago=days_ago,
        )


# ── Per-card scoring ────────────────────────────────────────────────────

async def test_record_card_result_awards_exactly_2_points_per_card():
    eaze_user_id = unique_id("test-user")
    result = await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=1, is_correct=True)

    assert result["persisted"] is True
    assert result["scoreEvent"]["points"] == 2

    score = await get_score_for_user(eaze_user_id)
    assert score["totalScore"] == 2


async def test_answering_the_same_card_twice_the_same_day_is_deduped():
    eaze_user_id = unique_id("test-user")

    first = await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=3, is_correct=False)
    assert first["scoreEvent"]["points"] == 2

    second = await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=3, is_correct=True)
    assert second["duplicate"] is True
    assert second["scoreEvent"] is None

    score = await get_score_for_user(eaze_user_id)
    assert score["totalScore"] == 2, "the repeat submission must not add any further points"


async def test_different_cards_in_the_same_session_each_score_independently():
    eaze_user_id = unique_id("test-user")
    await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=1, is_correct=True)
    await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=2, is_correct=False)
    await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=3, is_correct=True)

    score = await get_score_for_user(eaze_user_id)
    assert score["totalScore"] == 6


# ── Today's session state: resume + lock ───────────────────────────────

async def test_a_fresh_user_is_offered_session_1_unlocked_nothing_completed_today():
    eaze_user_id = unique_id("test-user")
    state = await get_today_session_state(eaze_user_id)

    assert state["sessionNumber"] == 1
    assert state["locked"] is False
    assert state["cardsCompletedToday"] == []
    assert state["msUntilMidnightIST"] is None


async def test_completing_all_15_cards_today_locks_the_session():
    eaze_user_id = unique_id("test-user")
    for card in range(1, 16):
        await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=card, is_correct=(card % 3 != 0))

    state = await get_today_session_state(eaze_user_id)
    assert state["locked"] is True
    assert len(state["cardsCompletedToday"]) == 15
    assert state["msUntilMidnightIST"] > 0
    # Spot-check the resume shape the frontend relies on to pre-mark dots.
    by_number = {c["cardNumber"]: c for c in state["cardsCompletedToday"]}
    assert by_number[3] == {"cardNumber": 3, "isCorrect": False}
    assert by_number[1] == {"cardNumber": 1, "isCorrect": True}


async def test_a_partially_completed_session_today_stays_unlocked():
    eaze_user_id = unique_id("test-user")
    await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=1, is_correct=True)
    await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=2, is_correct=True)

    state = await get_today_session_state(eaze_user_id)
    assert state["locked"] is False
    assert len(state["cardsCompletedToday"]) == 2
    assert state["msUntilMidnightIST"] is None


# ── One session per day: cycling + retry-on-incomplete ─────────────────

async def test_session_number_cycles_with_each_fully_completed_prior_day():
    eaze_user_id = unique_id("test-user")
    await complete_full_day(eaze_user_id, days_ago=3)
    await complete_full_day(eaze_user_id, days_ago=2)
    await complete_full_day(eaze_user_id, days_ago=1)

    # 3 completed prior days, small total_sessions so the wrap is exercised
    # without needing 20 real days of fixtures.
    state = await get_today_session_state(eaze_user_id, total_sessions=3, cards_per_session=15)
    assert state["sessionNumber"] == 1, "3 completed days % 3 total sessions wraps back to session 1"


async def test_a_partially_completed_prior_day_still_advances_the_cycle():
    eaze_user_id = unique_id("test-user")
    # Only 10 of 15 cards yesterday — never "completed", but the user did
    # engage with it, so that slot is spent and today rotates to session 2
    # rather than re-offering the abandoned session 1.
    for card in range(1, 11):
        await insert_backdated(eaze_user_id, session_number=1, card_number=card, is_correct=True, days_ago=1)

    state = await get_today_session_state(eaze_user_id, total_sessions=20, cards_per_session=15)
    assert state["sessionNumber"] == 2, "a session abandoned mid-way must not be re-offered the next day"


async def test_a_prior_day_with_zero_engagement_is_invisible_to_the_cycle():
    eaze_user_id = unique_id("test-user")
    await complete_full_day(eaze_user_id, days_ago=2)
    # days_ago=1 deliberately left completely untouched — no rows at all,
    # unlike the partial-engagement case above.

    state = await get_today_session_state(eaze_user_id, total_sessions=20, cards_per_session=15)
    assert state["sessionNumber"] == 2, "the untouched day contributes nothing"


async def test_finishing_todays_session_does_not_unlock_tomorrows():
    eaze_user_id = unique_id("test-user")
    for card in range(1, 16):
        await record_card_result(eaze_user_id=eaze_user_id, session_number=1, card_number=card, is_correct=True)

    state = await get_today_session_state(eaze_user_id, total_sessions=20, cards_per_session=15)
    assert state["sessionNumber"] == 1, "today must stay session 1 even though today is now fully complete"
    assert state["locked"] is True


# ── Lifetime "sessions completed" ────────────────────────────────────────

async def test_get_completed_sessions_count_only_counts_full_days():
    eaze_user_id = unique_id("test-user")
    await complete_full_day(eaze_user_id, days_ago=2)
    # Partial day — must not count.
    for card in range(1, 6):
        await insert_backdated(eaze_user_id, session_number=1, card_number=card, is_correct=True, days_ago=1)

    assert await get_completed_sessions_count(eaze_user_id) == 1


# ── Streak, with the "today isn't over yet" grace rule ──────────────────

async def test_a_streak_ending_yesterday_still_counts_today():
    eaze_user_id = unique_id("test-user")
    await complete_full_day(eaze_user_id, days_ago=3)
    await complete_full_day(eaze_user_id, days_ago=2)
    await complete_full_day(eaze_user_id, days_ago=1)

    assert await get_streak(eaze_user_id) == 3


async def test_completing_today_extends_the_streak_by_one_more():
    eaze_user_id = unique_id("test-user")
    await complete_full_day(eaze_user_id, days_ago=2)
    await complete_full_day(eaze_user_id, days_ago=1)
    await complete_full_day(eaze_user_id, days_ago=0)

    assert await get_streak(eaze_user_id) == 3


async def test_a_gap_in_prior_days_breaks_the_streak():
    eaze_user_id = unique_id("test-user")
    await complete_full_day(eaze_user_id, days_ago=3)
    # days_ago=2 deliberately skipped — breaks continuity.
    await complete_full_day(eaze_user_id, days_ago=1)

    assert await get_streak(eaze_user_id) == 1, "only yesterday is contiguous with today not yet played"


async def test_a_user_who_has_never_played_has_a_zero_streak():
    assert await get_streak(unique_id("never-seen")) == 0
