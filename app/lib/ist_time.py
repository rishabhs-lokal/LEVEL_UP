# Shared IST wall-clock helper for analytics log tables (login_logs_choices,
# session_logs_choices, and whatever comes later) — each row on those tables
# stores a log_date/log_time pair captured once at insert time, not a UTC
# timestamp converted later.
from datetime import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


def ist_now_parts():
    now = datetime.now(IST)
    return {"date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M:%S")}
