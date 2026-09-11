# Integration tests for the shared EazeScore ledger. These hit a real
# Postgres (DATABASE_URL must be set), not a mock, since the whole point of
# this ledger is correct SQL-level behavior (SUM, same-day windowing,
# transactional atomicity). Every test uses its own randomly-generated
# eaze_user_id so runs never collide with each other or with real data, and
# there's nothing to clean up after.
import uuid

from app.repositories.score_events import ensure_welcome_bonus, get_score_for_user, record_score_event


def unique_id(prefix):
    return f"{prefix}-{uuid.uuid4()}"


async def test_posting_a_score_event_creates_exactly_one_row():
    eaze_user_id = unique_id("test-user")
    result = await record_score_event(
        eaze_user_id=eaze_user_id, source_app="checkin", event_type="daily_checkin", points=10, metadata=None,
    )

    assert result["persisted"] is True
    assert result["event"]["eaze_user_id"] == eaze_user_id
    assert result["event"]["points"] == 10

    score = await get_score_for_user(eaze_user_id)
    assert len(score["events"]) == 1, "exactly one row should exist for this user"


async def test_get_returns_correct_sum_across_multiple_events_and_apps():
    eaze_user_id = unique_id("test-user")
    await record_score_event(eaze_user_id=eaze_user_id, source_app="level-up", event_type="card_complete", points=1)
    await record_score_event(eaze_user_id=eaze_user_id, source_app="checkin", event_type="daily_checkin", points=10)
    await record_score_event(eaze_user_id=eaze_user_id, source_app="level-up", event_type="card_complete", points=1)

    score = await get_score_for_user(eaze_user_id)
    assert score["totalScore"] == 12
    assert len(score["events"]) == 3


async def test_get_for_user_with_no_events_returns_a_zero_total_not_an_error():
    score = await get_score_for_user(unique_id("never-seen"))
    assert score["persisted"] is True
    assert score["totalScore"] == 0
    assert score["events"] == []


async def test_ensure_welcome_bonus_awards_20_points_once_and_is_a_no_op_later():
    eaze_user_id = unique_id("test-user")

    first = await ensure_welcome_bonus(eaze_user_id)
    assert first["awarded"] is True
    assert first["event"]["points"] == 20

    second = await ensure_welcome_bonus(eaze_user_id)
    assert second["awarded"] is False
    assert second["event"] is None

    score = await get_score_for_user(eaze_user_id)
    assert score["totalScore"] == 20, "bonus must be counted exactly once no matter how many times login fires it"
