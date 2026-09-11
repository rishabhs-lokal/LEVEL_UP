# Data access for the shared, append-only EazeScore ledger. Every app that
# reports activity into EazeScore (this one, eaze-checkin, and whatever
# comes later) writes rows here — total score is always derived by summing
# them, never stored as a mutable counter.
import math

from psycopg.types.json import Jsonb

from ..db.client import DB_ENABLED, query, with_transaction

SOURCE_APPS = ["checkin", "level-up"]

# Single source of truth for this event_type string — card_results.py
# imports it rather than redefining its own.
CARD_COMPLETE_EVENT_TYPE = "card_complete"

WELCOME_BONUS_EVENT_TYPE = "welcome_bonus"
WELCOME_BONUS_POINTS = 20
CLAIM_EVENT_TYPE = "claim"

# EazeScore -> coin conversion, tiered rather than 1:1: the first
# HALFWAY_THRESHOLD points of a claim convert at LOW_RATE, anything beyond
# that at HIGH_RATE. A claim always empties the full available balance (see
# claim_score below), never a partial amount. This app's HALFWAY_THRESHOLD is
# set independently of eaze-checkin's own backend/app/services/eaze_score.py
# compute_coins — the two apps share the score_events ledger itself, but not
# this rate; don't assume they need to match.
COIN_HALFWAY_THRESHOLD = 150
COIN_LOW_RATE = 0.5
COIN_HIGH_RATE = 1.0


# Rounds half up to a whole coin (e.g. an odd score at the 0.5 rate lands on
# an X.5 coin value, which rounds up, not down) — math.floor(x + 0.5) rather
# than round(), matching the JS reference's own reasoning exactly.
def compute_coins(score: int) -> int:
    if score <= 0:
        return 0
    if score <= COIN_HALFWAY_THRESHOLD:
        coins = score * COIN_LOW_RATE
    else:
        coins = COIN_HALFWAY_THRESHOLD * COIN_LOW_RATE + (score - COIN_HALFWAY_THRESHOLD) * COIN_HIGH_RATE
    return math.floor(coins + 0.5)


# Inserts one row using a caller-supplied client — for callers already
# inside a transaction (e.g. card_results.py's own session-complete flow,
# which needs the score event to land in the same transaction as the card
# result so the two can never go out of sync).
async def insert_score_event(client, *, eaze_user_id, source_app, event_type, points, metadata=None):
    result = await client.query(
        """INSERT INTO score_events (eaze_user_id, source_app, event_type, points, metadata)
           VALUES (%s, %s, %s, %s, %s)
           RETURNING id, eaze_user_id, source_app, event_type, points, metadata, created_at""",
        [eaze_user_id, source_app, event_type, points, Jsonb(metadata) if metadata is not None else None],
    )
    return result["rows"][0]


# Standalone entry point for callers with no transaction of their own — the
# POST /api/score/events route. Opens its own transaction for consistency
# with the rest of the write path, even though it's a single statement.
async def record_score_event(*, eaze_user_id, source_app, event_type, points, metadata=None):
    if not DB_ENABLED:
        return {"persisted": False}

    async def _run(client):
        return await insert_score_event(
            client, eaze_user_id=eaze_user_id, source_app=source_app,
            event_type=event_type, points=points, metadata=metadata,
        )

    event = await with_transaction(_run)
    return {"persisted": True, "event": event}


# Total is always derived by summing the ledger, never read from a stored
# counter — the whole point of an append-only event table. Lifetime
# "sessions completed" isn't derived here — that's a card_results concept
# now (see card_results.py's get_completed_sessions_count), not something
# score_events itself can answer.
async def get_score_for_user(eaze_user_id):
    if not DB_ENABLED:
        return {"persisted": False}

    sum_result = await query(
        "SELECT COALESCE(SUM(points), 0)::int AS total FROM score_events WHERE eaze_user_id = %s",
        [eaze_user_id],
    )
    events_result = await query(
        """SELECT id, source_app, event_type, points, metadata, created_at
           FROM score_events
           WHERE eaze_user_id = %s
           ORDER BY created_at DESC
           LIMIT 50""",
        [eaze_user_id],
    )

    return {
        "persisted": True,
        "eazeUserId": eaze_user_id,
        "totalScore": sum_result["rows"][0]["total"],
        "events": events_result["rows"],
    }


# Idempotent — safe to call on every login. The partial unique index on
# (eaze_user_id) WHERE event_type = 'welcome_bonus' (see the matching
# migration) makes the insert a no-op after the first successful call, so
# there's no separate check-then-insert race to worry about.
async def ensure_welcome_bonus(eaze_user_id):
    if not DB_ENABLED:
        return {"persisted": False, "awarded": False}

    async def _run(client):
        result = await client.query(
            """INSERT INTO score_events (eaze_user_id, source_app, event_type, points)
               VALUES (%s, 'level-up', %s, %s)
               ON CONFLICT (eaze_user_id) WHERE event_type = 'welcome_bonus' DO NOTHING
               RETURNING id, eaze_user_id, source_app, event_type, points, metadata, created_at""",
            [eaze_user_id, WELCOME_BONUS_EVENT_TYPE, WELCOME_BONUS_POINTS],
        )
        rows = result["rows"]
        return {"persisted": True, "awarded": len(rows) > 0, "event": rows[0] if rows else None}

    return await with_transaction(_run)


# A claim always empties the user's full available balance, never a partial
# amount — same rule as eaze-checkin's own claim_coins. "Available" IS
# totalScore here: unlike the Python (reference) schema's separate
# earned/claimed sum, this ledger has no split to maintain — a claim is just
# another (negative) row in the same append-only sum, so the total already
# reflects it the instant it's inserted, from either app, since both read
# the same rows.
async def claim_score(eaze_user_id):
    if not DB_ENABLED:
        return {"persisted": False}

    async def _run(client):
        sum_result = await client.query(
            "SELECT COALESCE(SUM(points), 0)::int AS total FROM score_events WHERE eaze_user_id = %s",
            [eaze_user_id],
        )
        available = sum_result["rows"][0]["total"]
        if available <= 0:
            return {"persisted": True, "claimed": False, "available": 0, "coins": 0}

        coins = compute_coins(available)
        # Ledger deduction is inserted before the transfer is even attempted
        # (see the /api/score/claim route) — a failed transfer never undoes
        # it, so a concurrent second claim always sees this deduction
        # already reflected.
        event = await insert_score_event(
            client, eaze_user_id=eaze_user_id, source_app="level-up",
            event_type=CLAIM_EVENT_TYPE, points=-available, metadata={"coins": coins},
        )

        return {"persisted": True, "claimed": True, "available": available, "coins": coins, "event": event}

    return await with_transaction(_run)
