# Append-only snapshot log (session_logs_choices) — one row per successfully
# completed session, capturing the user's lifetime sessions_count as of that
# completion. user_id is the real Eaze platform user id, distinct from
# phone_number (see login_logs.py) — only recorded when the caller actually
# has one (banner-entered users), never fabricated for the typed-phone dev
# login path.
from ..db.client import DB_ENABLED, query
from ..lib.ist_time import ist_now_parts


async def record_session_completion(*, user_id, phone_number, sessions_count):
    if not DB_ENABLED:
        return {"persisted": False}
    parts = ist_now_parts()
    result = await query(
        """INSERT INTO session_logs_choices (user_id, phone_number, sessions_count, log_date, log_time)
           VALUES (%s, %s, %s, %s, %s)
           RETURNING id, user_id, phone_number, sessions_count, log_date, log_time""",
        [user_id, phone_number, sessions_count, parts["date"], parts["time"]],
    )
    return {"persisted": True, "log": result["rows"][0]}
