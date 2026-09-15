import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .db.client import close_pool, health_check
from .repositories.card_results import (
    CARDS_PER_SESSION,
    TOTAL_SESSIONS,
    get_completed_sessions_count,
    get_streak,
    get_today_session_state,
    record_card_result,
)
from .repositories.claim_choices import record_claim
from .repositories.login_logs import record_first_login
from .repositories.open_session_logs import record_open_session_close
from .repositories.score_events import (
    SOURCE_APPS,
    claim_score,
    ensure_welcome_bonus,
    get_score_for_user,
    record_score_event,
)
from .services.coin_transfer import transfer_coins

BASE_DIR = Path(__file__).resolve().parent.parent
PUBLIC_DIR = BASE_DIR / "public"
CONTENT_PATH = BASE_DIR / "content" / "cards.json"

# Loaded once at boot — the deck is static content, not per-request data.
CARD_DECK = json.loads(CONTENT_PATH.read_text())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    # Matters with multiple pods behind a Service: on rolling update/scale-
    # down, Kubernetes sends SIGTERM and expects the pod to stop accepting
    # new connections, finish in-flight ones, then exit — uvicorn handles
    # the drain itself, this just closes the DB pool cleanly afterward.
    await close_pool()


app = FastAPI(lifespan=lifespan)


def ok(content, status_code=200):
    return JSONResponse(status_code=status_code, content=jsonable_encoder(content))


def error(status_code, message):
    return ok({"error": message}, status_code)


# ── Health / readiness (Kubernetes probes) ──────────────────────────────────
# /health = liveness: is the process alive. Never depends on the database, so
# a DB blip doesn't get a healthy pod killed.
@app.get("/health")
async def health():
    return ok({"status": "ok", "service": "eaze-level-up"})


# /ready = readiness: safe to receive traffic. Checks DB connectivity only
# when DATABASE_URL is configured — the game itself works fine without a
# database.
@app.get("/ready")
async def ready():
    db = await health_check()
    if not db["ok"]:
        return ok({"status": "not-ready", "db": db}, 503)
    return ok({"status": "ready", "db": db})


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/content")
async def get_content():
    return ok(CARD_DECK)


# One global session per day, 20 sessions x 15 cards, no topics — see
# card_results.py for how "today's session" is derived.

# Call before showing a session, so the frontend knows which session number
# to load, which of its cards are already answered today (resume), and
# whether today is already used up (darkened/locked state).
@app.get("/api/sessions/today/{eaze_user_id}")
async def sessions_today(eaze_user_id: str):
    if not eaze_user_id:
        return error(400, "eazeUserId is required")
    try:
        result = await get_today_session_state(
            eaze_user_id, total_sessions=TOTAL_SESSIONS, cards_per_session=CARDS_PER_SESSION,
        )
        return ok(result)
    except Exception as err:  # noqa: BLE001 — mirrors server.js's per-route catch
        return error(500, str(err))


@app.post("/api/cards/complete")
async def cards_complete(request: Request):
    try:
        body = await request.json()
        eaze_user_id = body.get("eazeUserId")
        session_number = body.get("sessionNumber")
        card_number = body.get("cardNumber")
        is_correct = body.get("isCorrect")
        user_id = body.get("userId")

        if not eaze_user_id or session_number is None or card_number is None or not isinstance(is_correct, bool):
            return error(400, "eazeUserId, sessionNumber, cardNumber and isCorrect (boolean) are required")

        result = await record_card_result(
            eaze_user_id=eaze_user_id,
            session_number=int(session_number),
            card_number=int(card_number),
            is_correct=is_correct,
            # Optional — only present for banner-entered (real identity)
            # users; see record_card_result's session_logs_choices hook.
            user_id=user_id if isinstance(user_id, str) else None,
        )
        return ok(result, 201)
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


# ── Shared EazeScore ledger ──────────────────────────────────────────────────
# The single source of truth for EazeScore across every app that reports into
# it (this one, eaze-checkin, and whatever comes later) — see
# repositories/score_events.py.

@app.post("/api/score/events")
async def post_score_event(request: Request):
    try:
        body = await request.json()
        eaze_user_id = body.get("eazeUserId")
        source_app = body.get("sourceApp")
        event_type = body.get("eventType")
        points = body.get("points")
        metadata = body.get("metadata")

        if not eaze_user_id or not isinstance(eaze_user_id, str):
            return error(400, "eazeUserId is required")
        if not event_type or not isinstance(event_type, str):
            return error(400, "eventType is required")
        if source_app not in SOURCE_APPS:
            return error(400, f"sourceApp must be one of: {', '.join(SOURCE_APPS)}")
        if not isinstance(points, int) or isinstance(points, bool) or points <= 0:
            return error(400, "points must be a positive integer")

        result = await record_score_event(
            eaze_user_id=eaze_user_id, source_app=source_app, event_type=event_type,
            points=points, metadata=metadata,
        )
        return ok(result, 201)
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


# Safe to call on every login — idempotent, see ensure_welcome_bonus.
@app.post("/api/score/welcome-bonus")
async def welcome_bonus(request: Request):
    try:
        body = await request.json()
        eaze_user_id = body.get("eazeUserId")
        if not eaze_user_id or not isinstance(eaze_user_id, str):
            return error(400, "eazeUserId is required")
        result = await ensure_welcome_bonus(eaze_user_id)
        return ok(result, 200)
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


# First-login-only tracking (login_logs_choices) — safe to call on every
# login, idempotent (see record_first_login). userId is the real Eaze
# platform user id, resolved by the caller — the same identity used as
# eazeUserId everywhere else in this app (score_events, card_results).
@app.post("/api/login-logs/first-login")
async def login_logs_first_login(request: Request):
    try:
        body = await request.json()
        user_id = body.get("userId")
        if not user_id or not isinstance(user_id, str):
            return error(400, "userId is required")
        result = await record_first_login(user_id=user_id)
        return ok(result, 200)
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


# Fired whenever a session closes, finished or abandoned early (see
# open_session_logs) — the frontend computes the final tally itself (it
# already has the per-card results in memory), no server-side derivation.
@app.post("/api/open-session-logs")
async def open_session_logs(request: Request):
    try:
        body = await request.json()
        user_id = body.get("userId")
        cards_engaged = body.get("cardsEngaged")
        wrong_selections = body.get("wrongSelections")

        if not user_id or not isinstance(user_id, str):
            return error(400, "userId is required")
        if not isinstance(cards_engaged, int) or isinstance(cards_engaged, bool) or \
           not isinstance(wrong_selections, int) or isinstance(wrong_selections, bool):
            return error(400, "cardsEngaged and wrongSelections must be integers")

        result = await record_open_session_close(
            user_id=user_id, cards_engaged=cards_engaged, wrong_selections=wrong_selections,
        )
        return ok(result, 200)
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


# Always empties the full available balance (see claim_score) — the ledger
# deduction lands before the transfer is even attempted, so a failed
# transfer never leaves a user able to claim the same points twice.
@app.post("/api/score/claim")
async def score_claim(request: Request):
    try:
        body = await request.json()
        eaze_user_id = body.get("eazeUserId")
        user_id = body.get("userId")

        if not eaze_user_id or not isinstance(eaze_user_id, str):
            return error(400, "eazeUserId is required")

        claim = await claim_score(eaze_user_id)
        if not claim["persisted"]:
            return error(503, "DATABASE_URL is not configured")
        if not claim["claimed"]:
            return error(400, "No EazeScore available to claim")

        # claim_choices only ever records banner-entered (real userId)
        # users — never fabricated for the typed-phone dev login path — and
        # a logging failure here must never take down the claim/transfer
        # that already succeeded.
        if user_id:
            try:
                await record_claim(user_id=user_id, eazescore_claimed=claim["available"])
            except Exception as log_err:  # noqa: BLE001
                print(f"claim_choices logging failed: {log_err}")

        try:
            transfer = await transfer_coins(eaze_user_id, claim["coins"])
        except Exception as transfer_err:  # noqa: BLE001
            transfer = {"status": "failed_provider", "providerRef": None, "notes": str(transfer_err)}

        return ok({
            "eazeScoreClaimed": claim["available"],
            "coinsRequested": claim["coins"],
            "status": transfer["status"],
            "providerRef": transfer["providerRef"],
            "notes": transfer["notes"],
        }, 201)
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


@app.get("/api/score/{eaze_user_id}")
async def get_score(eaze_user_id: str):
    if not eaze_user_id:
        return error(400, "eazeUserId is required")
    try:
        score, sessions_completed, streak = await asyncio.gather(
            get_score_for_user(eaze_user_id),
            get_completed_sessions_count(eaze_user_id),
            get_streak(eaze_user_id),
        )
        return ok({**score, "sessionsCompleted": sessions_completed, "streak": streak})
    except Exception as err:  # noqa: BLE001
        return error(500, str(err))


# ── Static frontend + fallback SPA ───────────────────────────────────────────
# Registered after every /api route above, so an incoming request only
# reaches these once none of the explicit routes matched.
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")


@app.exception_handler(StarletteHTTPException)
async def spa_fallback(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404 and not request.url.path.startswith("/api"):
        return FileResponse(PUBLIC_DIR / "index.html")
    return ok({"error": exc.detail}, exc.status_code)
