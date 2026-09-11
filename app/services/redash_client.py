# Phone-number fallback lookup for banner entries that hand over user_id but
# no phone (see boot()'s ?user_id=&phone= check in the frontend) — backed by
# the Lokal/Eaze analytics Redash instance, query 20342
# (https://analytics.getlokalapp.com/queries/20342), parameterized on
# user_ids and returning a mobile_no column (verified directly against the
# live API — the query joins eaze_pg_datastream.public_users_user on id).
#
# REDASH_API_KEY is required for this to do anything real; unset (or on any
# failure), it degrades to "no phone found" rather than raising, since
# phone_number is only ever an attribute here (score_events/card_results key
# on user_id regardless — see repositories/card_results.py), never
# load-bearing for login or scoring.
from __future__ import annotations

import asyncio
import os

import httpx

REDASH_BASE_URL = os.environ.get("REDASH_BASE_URL", "https://analytics.getlokalapp.com")
REDASH_PHONE_QUERY_ID = os.environ.get("REDASH_PHONE_QUERY_ID", "20342")
REDASH_PHONE_COLUMN = os.environ.get("REDASH_PHONE_COLUMN", "mobile_no")

# Redash job status codes: 1 pending, 2 started, 3 success, 4 failure,
# 5 canceled. 3 is the only one that yields a query_result_id.
_JOB_SUCCESS = 3
_JOB_TERMINAL = {3, 4, 5}
_POLL_INTERVAL_SECONDS = 1
_MAX_POLLS = 10

# In-memory, per-process cache — phone numbers don't change often enough to
# justify re-running a data-warehouse-backed query (multi-second latency) on
# every login for the same user. Not shared across pods/replicas; that's
# fine, it only causes a redundant lookup, never a wrong one.
_phone_cache: dict[str, str | None] = {}


async def _fetch_query_result(client: httpx.AsyncClient, headers: dict, user_id: str) -> dict | None:
    response = await client.post(
        f"{REDASH_BASE_URL}/api/queries/{REDASH_PHONE_QUERY_ID}/results",
        headers=headers,
        json={"parameters": {"user_ids": user_id}, "max_age": 0},
    )
    response.raise_for_status()
    body = response.json()

    if "query_result" in body:
        return body["query_result"]

    job = body.get("job")
    if not job:
        return None

    job_id = job["id"]
    for _ in range(_MAX_POLLS):
        if job.get("status") in _JOB_TERMINAL:
            break
        await asyncio.sleep(_POLL_INTERVAL_SECONDS)
        job_response = await client.get(f"{REDASH_BASE_URL}/api/jobs/{job_id}", headers=headers)
        job_response.raise_for_status()
        job = job_response.json()["job"]

    if job.get("status") != _JOB_SUCCESS or not job.get("query_result_id"):
        return None

    result_response = await client.get(
        f"{REDASH_BASE_URL}/api/query_results/{job['query_result_id']}", headers=headers,
    )
    result_response.raise_for_status()
    return result_response.json()["query_result"]


async def lookup_phone_number(user_id: str) -> str | None:
    if user_id in _phone_cache:
        return _phone_cache[user_id]

    api_key = os.environ.get("REDASH_API_KEY")
    if not api_key:
        return None

    phone = None
    try:
        headers = {"Authorization": f"Key {api_key}"}
        async with httpx.AsyncClient(timeout=15) as client:
            query_result = await _fetch_query_result(client, headers, user_id)
        if query_result:
            rows = query_result["data"]["rows"]
            if rows and rows[0].get(REDASH_PHONE_COLUMN):
                phone = str(rows[0][REDASH_PHONE_COLUMN])
    except Exception:  # noqa: BLE001 — analytics-service hiccups must never block login
        phone = None

    _phone_cache[user_id] = phone
    return phone
