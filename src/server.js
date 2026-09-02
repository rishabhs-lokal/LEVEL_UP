import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool, healthCheck } from './db/client.js';
import { recordSessionResult } from './repositories/session-results.js';
import { recordScoreEvent, getScoreForUser, ensureWelcomeBonus, SOURCE_APPS } from './repositories/score-events.js';

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

app.post('/api/sessions/complete', async (req, res) => {
  try {
    const { eazeUserId, topicId, sessionNumber, correctCount, totalCount, bestStreak, durationMs } = req.body;

    if (!eazeUserId || !topicId || !sessionNumber || correctCount == null || totalCount == null) {
      return res.status(400).json({ error: 'eazeUserId, topicId, sessionNumber, correctCount and totalCount are required' });
    }

    const result = await recordSessionResult({
      eazeUserId, topicId,
      sessionNumber: Number(sessionNumber),
      correctCount: Number(correctCount),
      totalCount: Number(totalCount),
      bestStreak: Number(bestStreak || 0),
      durationMs: durationMs != null ? Number(durationMs) : null,
      totalTopicCount: cardDeck.topics.length,
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

app.get('/api/score/:eazeUserId', async (req, res) => {
  try {
    const { eazeUserId } = req.params;
    if (!eazeUserId) {
      return res.status(400).json({ error: 'eazeUserId is required' });
    }
    const result = await getScoreForUser(eazeUserId);
    res.json(result);
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
