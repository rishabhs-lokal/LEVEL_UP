# Append-only log (claim_choices) — one row per successful coin claim,
# capturing the EazeScore balance that was converted at claim time. user_id
# is the real Eaze platform user id (see login_logs.py); only recorded when
# the caller actually has one (banner-entered users), never fabricated for
# the typed-phone dev login path.
from ..db.client import DB_ENABLED, query
from ..lib.ist_time import ist_now_parts


async def record_claim(*, user_id, phone_number, eazescore_claimed):
    if not DB_ENABLED:
        return {"persisted": False}
    parts = ist_now_parts()
    result = await query(
        """INSERT INTO claim_choices (user_id, phone_number, eazescore_claimed, log_date, log_time)
           VALUES (%s, %s, %s, %s, %s)
           RETURNING id, user_id, phone_number, eazescore_claimed, log_date, log_time""",
        [user_id, phone_number, eazescore_claimed, parts["date"], parts["time"]],
    )
    return {"persisted": True, "log": result["rows"][0]}
