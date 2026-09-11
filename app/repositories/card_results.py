# Per-card result tracking for the content model: 20 sessions x 15 cards, no
# topics, one global session per day, 2 EazeScore per card engaged with
# (answered, right or wrong — see record_card_result). There's no separate
# "sessions" table — a completed session is derived as >=15 distinct
# card_number rows for the same eaze_user_id + IST day.
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from ..db.client import DB_ENABLED, query, with_transaction
from .score_events import CARD_COMPLETE_EVENT_TYPE, insert_score_event
from .session_count import record_session_engagement
from .session_logs import record_session_completion

CARDS_PER_SESSION = 15
TOTAL_SESSIONS = 20
CARD_POINTS = 2

IST = ZoneInfo("Asia/Kolkata")


def get_ist_date_string(instant: datetime | None = None) -> str:
    instant = instant or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(IST).strftime("%Y-%m-%d")


def _add_days_to_date_string(date_str: str, delta: int) -> str:
    year, month, day = (int(part) for part in date_str.split("-"))
    dt = datetime(year, month, day, tzinfo=timezone.utc) + timedelta(days=delta)
    return dt.strftime("%Y-%m-%d")


def _ms_until_next_ist_midnight() -> int:
    now_ist = datetime.now(IST)
    seconds_since_midnight = now_ist.hour * 3600 + now_ist.minute * 60 + now_ist.second
    return (24 * 3600 - seconds_since_midnight) * 1000


# One row per card answered. ON CONFLICT targets
# card_results_one_per_card_per_day (see the matching migration) — a card
# already answered today earns nothing further, but the same card can be
# answered again (and re-scored) on a later day if that day's session was
# never completed the first time around.
async def record_card_result(*, eaze_user_id, session_number, card_number, is_correct, user_id=None, phone_number=None):
    if not DB_ENABLED:
        return {"persisted": False}

    async def _run(client):
        insert_result = await client.query(
            """INSERT INTO card_results (eaze_user_id, session_number, card_number, is_correct)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (eaze_user_id, session_number, card_number, ((created_at AT TIME ZONE 'Asia/Kolkata')::date))
               DO NOTHING
               RETURNING id""",
            [eaze_user_id, session_number, card_number, is_correct],
        )

        if not insert_result["rows"]:
            return {"persisted": True, "scoreEvent": None, "duplicate": True}

        score_event = await insert_score_event(
            client, eaze_user_id=eaze_user_id, source_app="level-up",
            event_type=CARD_COMPLETE_EVENT_TYPE, points=CARD_POINTS,
            metadata={"sessionNumber": session_number, "cardNumber": card_number},
        )

        # Whether THIS card is the one that just started or just completed
        # today's session — both checked in the same transaction as the
        # insert above, so a concurrent duplicate request can never
        # double-count either edge.
        count_result = await client.query(
            """SELECT COUNT(*)::int AS count FROM card_results
               WHERE eaze_user_id = %s AND session_number = %s
                 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date""",
            [eaze_user_id, session_number],
        )
        count = count_result["rows"][0]["count"]

        return {
            "persisted": True,
            "scoreEvent": score_event,
            "justStartedSession": count == 1,
            "justCompletedSession": count == CARDS_PER_SESSION,
        }

    result = await with_transaction(_run)

    # session_count and session_logs_choices only ever record banner-entered
    # (real user_id) users — never fabricated for the typed-phone dev login
    # path — and only fire on the exact card that started/completed the
    # session, not every card.
    if result.get("justStartedSession") and user_id:
        await record_session_engagement(user_id=user_id, phone_number=phone_number or eaze_user_id, session_number=session_number)
    if result.get("justCompletedSession") and user_id:
        sessions_count = await get_completed_sessions_count(eaze_user_id)
        await record_session_completion(user_id=user_id, phone_number=phone_number or eaze_user_id, sessions_count=sessions_count)

    return result


# Calendar days (IST, as 'YYYY-MM-DD' strings straight from Postgres — no
# Python-side timezone math) where the user answered at least `min_cards`
# cards.
async def _get_completed_day_strings(eaze_user_id, min_cards):
    result = await query(
        """SELECT TO_CHAR((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day
           FROM card_results
           WHERE eaze_user_id = %s
           GROUP BY day
           HAVING COUNT(*) >= %s
           ORDER BY day""",
        [eaze_user_id, min_cards],
    )
    return [row["day"] for row in result["rows"]]


# Days the user touched at least one card, complete or not — used only for
# session-number rotation (see get_today_session_state): a day left
# completely untouched (no rows at all — a user who never opened that day's
# session) must not advance the rotation, so the same session is offered
# again next time, but a day with even one card answered has "used up" that
# slot and rotation should move on, same as a full completion would.
# Completion-based stats (get_completed_sessions_count, get_streak) stay on
# the >=CARDS_PER_SESSION threshold — this is a distinct, looser notion of
# "a day counted."
async def _get_engaged_day_strings(eaze_user_id):
    return await _get_completed_day_strings(eaze_user_id, 1)


def _compute_streak(completed_day_set, as_of):
    streak = 0
    cursor = as_of
    while cursor in completed_day_set:
        streak += 1
        cursor = _add_days_to_date_string(cursor, -1)
    return streak


async def get_completed_sessions_count(eaze_user_id):
    if not DB_ENABLED:
        return 0
    days = await _get_completed_day_strings(eaze_user_id, CARDS_PER_SESSION)
    return len(days)


# Consecutive IST days (ending today, or yesterday if today isn't finished
# yet so a streak doesn't visibly read as broken before midnight actually
# passes — same grace rule eaze-checkin uses) with a fully completed
# session. Lives on the lifetime EazeScore page, not the gameplay-entry
# check below.
async def get_streak(eaze_user_id):
    if not DB_ENABLED:
        return 0
    completed_day_set = set(await _get_completed_day_strings(eaze_user_id, CARDS_PER_SESSION))
    today = get_ist_date_string()
    streak = _compute_streak(completed_day_set, today)
    if streak > 0:
        return streak
    return _compute_streak(completed_day_set, _add_days_to_date_string(today, -1))


# The single source of truth for "what should this user see right now when
# they try to play": which session number is next, which of its cards are
# already answered today (so the frontend can skip straight past them on
# resume), and whether today's session is already fully done (locked, per
# §7's darkened button).
async def get_today_session_state(eaze_user_id, total_sessions=TOTAL_SESSIONS, cards_per_session=CARDS_PER_SESSION):
    if not DB_ENABLED:
        return {"persisted": False}

    # Today itself must be excluded when deriving the session number — if it
    # weren't, finishing today's session would immediately advance the count
    # and hand back tomorrow's (unlocked) session number in the very same
    # response, defeating "one session per day" the instant it's satisfied.
    #
    # Rotation is driven by ENGAGED days, not just completed ones: a session
    # left entirely untouched keeps showing up as-is (no rows exist for that
    # day, so it never enters this set), but a session merely started and
    # abandoned (1-14 cards) still counts as that day's slot used, so the
    # next day rotates forward to the next session rather than re-offering
    # the abandoned one.
    engaged_days = await _get_engaged_day_strings(eaze_user_id)
    today = get_ist_date_string()
    engaged_days_before_today = [d for d in engaged_days if d != today]
    session_number = (len(engaged_days_before_today) % total_sessions) + 1

    today_result = await query(
        """SELECT card_number, is_correct FROM card_results
           WHERE eaze_user_id = %s AND session_number = %s
             AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
           ORDER BY card_number""",
        [eaze_user_id, session_number],
    )
    cards_completed_today = [
        {"cardNumber": row["card_number"], "isCorrect": row["is_correct"]} for row in today_result["rows"]
    ]
    locked = len(cards_completed_today) >= cards_per_session

    return {
        "persisted": True,
        "sessionNumber": session_number,
        "cardsPerSession": cards_per_session,
        "cardsCompletedToday": cards_completed_today,
        "locked": locked,
        "msUntilMidnightIST": _ms_until_next_ist_midnight() if locked else None,
    }
