# Append-only log (open_session_logs) — one row per session close, whether
# finished or abandoned early. user_id is the real Eaze platform user id
# (see login_logs.py); only recorded when the caller actually has one
# (banner-entered users), never fabricated for the typed-phone dev login
# path.
from ..db.client import DB_ENABLED, query
from ..lib.ist_time import ist_now_parts


async def record_open_session_close(*, user_id, cards_engaged, wrong_selections):
    if not DB_ENABLED:
        return {"persisted": False}
    parts = ist_now_parts()
    result = await query(
        """INSERT INTO open_session_logs (user_id, cards_engaged, wrong_selections, log_date, log_time)
           VALUES (%s, %s, %s, %s, %s)
           RETURNING id, user_id, cards_engaged, wrong_selections, log_date, log_time""",
        [user_id, cards_engaged, wrong_selections, parts["date"], parts["time"]],
    )
    return {"persisted": True, "log": result["rows"][0]}
