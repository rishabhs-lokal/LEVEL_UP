// Shared IST wall-clock helper for analytics log tables (login_logs_choices,
// session_logs_choices, and whatever comes later) — each row on those tables
// stores a log_date/log_time pair captured once at insert time, not a UTC
// timestamp converted later.
export function istNowParts() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now); // YYYY-MM-DD
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(now); // HH:MM:SS
  return { date, time };
}
