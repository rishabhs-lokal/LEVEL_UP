# Generic Postgres client. No app-specific queries live here — this module
# only knows how to connect, query, run transactions, and report health
# against any Postgres-compliant database reachable via DATABASE_URL.
from __future__ import annotations

import os

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

DB_ENABLED = bool(os.environ.get("DATABASE_URL"))

_pool: AsyncConnectionPool | None = None


def _build_conninfo() -> str:
    database_url = os.environ["DATABASE_URL"]
    sslmode = "require" if os.environ.get("DB_SSL") == "true" else "disable"
    sep = "&" if "?" in database_url else "?"
    return f"{database_url}{sep}sslmode={sslmode}"


async def _ensure_pool() -> AsyncConnectionPool:
    global _pool
    if not DB_ENABLED:
        raise RuntimeError("DATABASE_URL is not configured")
    if _pool is None:
        _pool = AsyncConnectionPool(
            conninfo=_build_conninfo(),
            min_size=1,
            max_size=int(os.environ.get("DB_POOL_MAX", "10")),
            timeout=5,
            max_idle=30,
            open=False,
        )
        await _pool.open()
    return _pool


class TxClient:
    """Wraps a single transactional connection with the same query() shape
    as the module-level query() below, for repository code that needs
    several statements to share one transaction."""

    def __init__(self, conn):
        self._conn = conn

    async def query(self, sql, params=None):
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params or [])
            rows = await cur.fetchall() if cur.description else []
            return {"rows": rows}


async def query(sql, params=None):
    pool = await _ensure_pool()
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params or [])
            rows = await cur.fetchall() if cur.description else []
            return {"rows": rows}


async def with_transaction(fn):
    pool = await _ensure_pool()
    async with pool.connection() as conn:
        async with conn.transaction():
            return await fn(TxClient(conn))


async def health_check():
    if not DB_ENABLED:
        return {"ok": True, "configured": False}
    try:
        await query("SELECT 1")
        return {"ok": True, "configured": True}
    except Exception as err:  # noqa: BLE001 — surfaced as a health payload, not raised
        return {"ok": False, "configured": True, "error": str(err)}


# Called from the app's shutdown lifespan hook so pods drain cleanly during
# a Kubernetes rolling update instead of dropping connections.
async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
