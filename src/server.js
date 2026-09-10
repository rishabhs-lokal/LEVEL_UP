import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool, healthCheck } from './db/client.js';
import { recordCardResult, getTodaySessionState, getCompletedSessionsCount, getStreak, TOTAL_SESSIONS, CARDS_PER_SESSION } from './repositories/card-results.js';
import { recordScoreEvent, getScoreForUser, ensureWelcomeBonus, claimScore, SOURCE_APPS } from './repositories/score-events.js';
import { transferCoins } from './services/coin-transfer.js';
import { recordFirstLogin } from './repositories/login-logs.js';
import { recordOpenSessionClose } from './repositories/open-session-logs.js';
import { recordClaim } from './repositories/claim-choices.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const publicDir  = path.join(__dirname, '..', 'public');
const contentPath = path.join(__dirname, '..', 'content', 'cards.json');

const app  = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(publicDir));

// Loaded once at boot — the deck is static content, not per-request data.
const cardDeck = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

// ── Health / readiness (Kubernetes probes) ─────────────────────────────────────
// /health = liveness: is the process alive. Never depends on the database, so a
// DB blip doesn't get a healthy pod killed.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eaze-level-up' });
});

// /ready = readiness: safe to receive traffic. Checks DB connectivity only when
// DATABASE_URL is configured — the game itself works fine without a database.
app.get('/ready', async (_req, res) => {
  const db = await healthCheck();
  if (!db.ok) return res.status(503).json({ status: 'not-ready', db });
  res.json({ status: 'ready', db });
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/content', (_req, res) => {
  res.json(cardDeck);
});

// One global session per day, 20 sessions x 15 cards, no topics — see
// card-results.js for how "today's session" is derived.

// Call before showing a session, so the frontend knows which session number
// to load, which of its cards are already answered today (resume), and
// whether today is already used up (darkened/locked state).
app.get('/api/sessions/today/:eazeUserId', async (req, res) => {
  try {
    const { eazeUserId } = req.params;
    if (!eazeUserId) {
      return res.status(400).json({ error: 'eazeUserId is required' });
    }
    const result = await getTodaySessionState(eazeUserId, {
      totalSessions: TOTAL_SESSIONS,
      cardsPerSession: CARDS_PER_SESSION,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cards/complete', async (req, res) => {
  try {
    const { eazeUserId, sessionNumber, cardNumber, isCorrect, userId } = req.body;

    if (!eazeUserId || sessionNumber == null || cardNumber == null || typeof isCorrect !== 'boolean') {
      return res.status(400).json({ error: 'eazeUserId, sessionNumber, cardNumber and isCorrect (boolean) are required' });
    }

    const result = await recordCardResult({
      eazeUserId,
      sessionNumber: Number(sessionNumber),
      cardNumber: Number(cardNumber),
      isCorrect,
      // Optional — only present for banner-entered (real identity) users;
      // see recordCardResult's session_logs_choices hook.
      userId: typeof userId === 'string' ? userId : undefined,
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Shared EazeScore ledger ─────────────────────────────────────────────────────
// The single source of truth for EazeScore across every app that reports into
// it (this one, eaze-checkin, and whatever comes later) — see score-events.js.

app.post('/api/score/events', async (req, res) => {
  try {
    const { eazeUserId, sourceApp, eventType, points, metadata } = req.body;

    if (!eazeUserId || typeof eazeUserId !== 'string') {
      return res.status(400).json({ error: 'eazeUserId is required' });
    }
    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ error: 'eventType is required' });
    }
    if (!SOURCE_APPS.includes(sourceApp)) {
      return res.status(400).json({ error: `sourceApp must be one of: ${SOURCE_APPS.join(', ')}` });
    }
    if (!Number.isInteger(points) || points <= 0) {
      return res.status(400).json({ error: 'points must be a positive integer' });
    }

    const result = await recordScoreEvent({ eazeUserId, sourceApp, eventType, points, metadata });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Safe to call on every login — idempotent, see ensureWelcomeBonus.
app.post('/api/score/welcome-bonus', async (req, res) => {
  try {
    const { eazeUserId } = req.body;
    if (!eazeUserId || typeof eazeUserId !== 'string') {
      return res.status(400).json({ error: 'eazeUserId is required' });
    }
    const result = await ensureWelcomeBonus(eazeUserId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// First-login-only tracking (login_logs_choices) — safe to call on every
// login, idempotent (see recordFirstLogin). userId is the real Eaze
// platform user id, resolved by the caller — not the same value as
// eazeUserId (the phone number) used everywhere else in this app.
app.post('/api/login-logs/first-login', async (req, res) => {
  try {
    const { userId, phoneNumber } = req.body;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return res.status(400).json({ error: 'phoneNumber is required' });
    }
    const result = await recordFirstLogin({ userId, phoneNumber });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fired whenever a session closes, finished or abandoned early (see
// open_session_logs) — the frontend computes the final tally itself (it
// already has the per-card results in memory), no server-side derivation.
app.post('/api/open-session-logs', async (req, res) => {
  try {
    const { userId, phoneNumber, cardsEngaged, wrongSelections } = req.body;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return res.status(400).json({ error: 'phoneNumber is required' });
    }
    if (!Number.isInteger(cardsEngaged) || !Number.isInteger(wrongSelections)) {
      return res.status(400).json({ error: 'cardsEngaged and wrongSelections must be integers' });
    }
    const result = await recordOpenSessionClose({ userId, phoneNumber, cardsEngaged, wrongSelections });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Always empties the full available balance (see claimScore) — the ledger
// deduction lands before the transfer is even attempted, so a failed
// transfer never leaves a user able to claim the same points twice.
app.post('/api/score/claim', async (req, res) => {
  try {
    const { eazeUserId, userId } = req.body;
    if (!eazeUserId || typeof eazeUserId !== 'string') {
      return res.status(400).json({ error: 'eazeUserId is required' });
    }

    const claim = await claimScore(eazeUserId);
    if (!claim.persisted) {
      return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    }
    if (!claim.claimed) {
      return res.status(400).json({ error: 'No EazeScore available to claim' });
    }

    // claim_choices only ever records banner-entered (real userId) users —
    // never fabricated for the typed-phone dev login path — and a logging
    // failure here must never take down the claim/transfer that already
    // succeeded.
    if (userId) {
      try {
        await recordClaim({ userId, phoneNumber: eazeUserId, eazescoreClaimed: claim.available });
      } catch (err) {
        console.error('claim_choices logging failed', err);
      }
    }

    let transfer;
    try {
      transfer = await transferCoins(eazeUserId, claim.coins);
    } catch (err) {
      transfer = { status: 'failed_provider', providerRef: null, notes: err.message };
    }

    res.status(201).json({
      eazeScoreClaimed: claim.available,
      coinsRequested: claim.coins,
      status: transfer.status,
      providerRef: transfer.providerRef,
      notes: transfer.notes,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/score/:eazeUserId', async (req, res) => {
  try {
    const { eazeUserId } = req.params;
    if (!eazeUserId) {
      return res.status(400).json({ error: 'eazeUserId is required' });
    }
    const [score, sessionsCompleted, streak] = await Promise.all([
      getScoreForUser(eazeUserId),
      getCompletedSessionsCount(eazeUserId),
      getStreak(eazeUserId),
    ]);
    res.json({ ...score, sessionsCompleted, streak });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Fallback SPA ──────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error(`eaze level up error on ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ error: err.message });
});

const server = app.listen(port, () => {
  console.log(`eaze level up running on http://localhost:${port}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Matters with multiple pods behind a Service: on rolling update/scale-down,
// Kubernetes sends SIGTERM and expects the pod to stop accepting new
// connections, finish in-flight ones, then exit — not drop the DB pool cold.
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
