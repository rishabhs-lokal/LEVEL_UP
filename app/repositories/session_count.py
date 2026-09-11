# Append-only log (session_count) — one row per session a user engages
# with, fired on the first card answered for that session_number/day. Same
# conventions as the other choices-app log tables: user_id is the real Eaze
# platform user id, only recorded when the caller actually has one
# (banner-entered users), never fabricated for the typed-phone dev login
# path.
from ..db.client import DB_ENABLED, query
from ..lib.ist_time import ist_now_parts


async def record_session_engagement(*, user_id, phone_number, session_number):
    if not DB_ENABLED:
        return {"persisted": False}
    parts = ist_now_parts()
    result = await query(
        """INSERT INTO session_count (user_id, phone_number, session_number, log_date, log_time)
           VALUES (%s, %s, %s, %s, %s)
           RETURNING id, user_id, phone_number, session_number, log_date, log_time""",
        [user_id, phone_number, session_number, parts["date"], parts["time"]],
    )
    return {"persisted": True, "log": result["rows"][0]}
