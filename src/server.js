import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool, healthCheck } from './db/client.js';
import { recordSessionResult } from './repositories/session-results.js';

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
    const { clientId, displayName, topicId, sessionNumber, correctCount, totalCount, bestStreak, durationMs } = req.body;

    if (!clientId || !topicId || !sessionNumber || correctCount == null || totalCount == null) {
      return res.status(400).json({ error: 'clientId, topicId, sessionNumber, correctCount and totalCount are required' });
    }

    const result = await recordSessionResult({
      clientId, displayName, topicId,
      sessionNumber: Number(sessionNumber),
      correctCount: Number(correctCount),
      totalCount: Number(totalCount),
      bestStreak: Number(bestStreak || 0),
      durationMs: durationMs != null ? Number(durationMs) : null,
    });

    res.status(201).json(result);
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
