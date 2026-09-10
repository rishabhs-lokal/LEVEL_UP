# Eaze - Choices

A "this-or-that" swipe card game for [eaze](https://eazeapp.com) — read a short word or moment, swipe left or right to sort it, and get an explanation when you get it wrong.

## What this is

| Part | Description |
|------|-------------|
| **Frontend** | Single-file HTML/CSS/Vanilla JS WebView (`public/index.html`). No framework, no build step. Max-width 430px, mobile-first. Visual theme (dark palette, brand color, logo, font) matches [eaze-spin-wheel](https://github.com/chitrarth05/eaze-spin-wheel). |
| **Backend** | Node.js + Express. Serves the static app, the card deck (`content/cards.json`), and records per-card results + the shared EazeScore ledger in Postgres via a generic DB client (`src/db/client.js`). |
| **Content** | 20 sessions × 15 cards = 300 cards, no topics — each card carries its own pair of options. Parsed into `content/cards.json` by `scripts/parse-quickplay-content.py` from the source markdown. |
| **Login** | Mobile-number gate, client-side only — there's no SMS/OTP backend yet, so `9999999999` is the only number that logs in. See [Login](#login). |

## How it plays

1. Log in with the test mobile number (see below).
2. Land on **Your EazeScore** (lifetime total, sessions played, day streak), then Home.
3. Home shows the running EazeScore and a single CTA: play (or resume) today's session.
4. A session is 15 cards, each with its own word/moment and its own pair of options. Swipe (or tap an option button) to sort it.
5. Correct swipe → a green confirmation banner, with a combo counter for streaks. **+1 EazeScore per card**, scored the instant you answer it — not batched at the end.
6. Wrong swipe → a coach explains why, in plain language.
7. Finish all 15 cards → a level-complete screen with your score, accuracy, and EazeScore earned this visit.

### One session a day

- Every player gets **exactly one session per day**, resetting at midnight IST. Once it's done, Home's play button goes dark: "Today's session is complete · New session in Xh Ym".
- Logging out (or closing the app) mid-session doesn't lose progress — each card is scored server-side as it's answered, so coming back later the same day (any time up to 11:59pm IST) resumes exactly where you left off, skipping straight past the cards you already answered.
- An unfinished session (didn't reach 15 cards before the day ended) is offered again the next day rather than skipping ahead — the session number only advances on a fully completed day.
- Session numbers cycle 1→ 20 → 1 based on how many prior days were fully completed.

## Login

There's no SMS/OTP provider wired up yet, so login is a whitelist of one:

- **Test number:** `9999999999`
- Any other 10-digit number is rejected with an inline error.
- Login state lives in `localStorage` (`eazeLevelUpMobile`) — "Log out" on the home screen clears it.
- The whitelist is `CONFIG.testNumbers` in `public/index.html`; extend it there once real numbers are needed.

## Repo structure

```
eaze-level-up/
├── public/
│   ├── index.html          # The entire game — screens, styles, logic
│   └── eaze-logo.png        # Wordmark, extracted from eaze-spin-wheel
├── src/
│   ├── server.js            # Express routes: static app, /api/content, /api/sessions/*, /api/cards/*, /api/score/*, /health, /ready
│   ├── db/
│   │   └── client.js        # Generic Postgres client (pool, query, transaction, health check)
│   └── repositories/
│       ├── card-results.js     # Per-card results, today's-session state, streak, completed-session count
│       └── score-events.js     # Shared, cross-app EazeScore ledger (append-only)
├── migrations/               # node-pg-migrate, ESM migration files
├── content/
│   └── cards.json            # Parsed card deck (generated) — 20 sessions x 15 cards
├── scripts/
│   ├── parse-quickplay-content.py  # Regenerates cards.json from the source markdown
│   └── test-connection.js
├── tests/
│   ├── card-results.test.js    # Per-card scoring, session cycling, locking, streak grace rule
│   └── score-events.test.js    # Shared EazeScore ledger
├── k8s/                       # Deployment, Service, ConfigMap/Secret templates, migration Job
├── Dockerfile
├── docker-compose.yml         # Local dev: postgres → one-shot migrate → app
└── package.json
```

## Local development

```bash
docker compose up -d --build   # postgres, one-shot migrations, then the app
```

Open http://localhost:3000. `public/` and `content/` are bind-mounted into the `app` container, so editing them on the host reflects immediately — no rebuild. `src/` is **not** bind-mounted (it's baked into the image), so a backend change needs `docker compose up -d --build app` to take effect. Postgres credentials and `DATABASE_URL` are hardcoded in `docker-compose.yml` for local dev; there's nothing to configure.

Without Docker (no DB, local-only mode — results just aren't persisted):

```bash
npm install
npm run dev              # http://localhost:3000
```

Copy `.env.example` to `.env` first if you want this mode to talk to a database (e.g. one already running from `docker compose up postgres`).

To regenerate the card deck after editing the source content doc:

```bash
npm run content:parse
```

## Database & migrations

Migrations use [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) — the standard tool for raw-SQL Postgres projects. Running the app without `DATABASE_URL` set works fine (results just aren't persisted); no leaderboard is implemented either way.

```bash
npm run migrate:up       # apply pending migrations (idempotent, safe to re-run)
npm run migrate:down     # roll back the last migration
npm run migrate:create <name>   # scaffold a new migration
```

In `docker-compose.yml`, migrations run once via a dedicated `migrate` service that the `app` service waits on (`condition: service_completed_successfully`).

## Tests

```bash
npm test        # node --test tests/*.test.js — needs DATABASE_URL, hits a real Postgres
```

Every test uses its own randomly-generated `eazeUserId`, so runs never collide with each other or with real data.

## Kubernetes

Manifests live in `k8s/`, all in the shared `eaze` namespace (same one eaze-checkin's backend deploys into) — a 3-replica Deployment with `/health` (liveness) and `/ready` (readiness, checks DB connectivity) probes, a ConfigMap/Secret split, and `migration-job.yaml`: a one-time Job, deleted and reapplied on every deploy, that runs to completion **before** the Deployment rolls out, so migrations run exactly once per release rather than once per pod.

`scripts/deploy.sh` is the reference deploy sequence: apply namespace/config/service, delete-and-reapply the migration Job and wait for it to complete, then roll out the Deployment (3 replicas by default):

```bash
kubectl create secret generic eaze-level-up-secrets -n eaze \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/db'
./scripts/deploy.sh
```

Replace `OWNER` in the image references (see `k8s/deployment.yaml` and `k8s/migration-job.yaml`) with your built & pushed image — never commit a filled-in secret (see `k8s/secret.example.yaml` for the expected keys).

## API routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Liveness check |
| GET | `/ready` | Readiness check — verifies DB connectivity when `DATABASE_URL` is set |
| GET | `/api/content` | Full card deck (20 sessions x 15 cards) |
| GET | `/api/sessions/today/:eazeUserId` | Today's session number, cards already answered today (for resume), locked state, ms until midnight IST |
| POST | `/api/cards/complete` | Records one card's answer — 1 EazeScore point, deduped per card per day |
| POST | `/api/score/events` | Generic write into the shared EazeScore ledger (used by other apps too) |
| POST | `/api/score/welcome-bonus` | Idempotent one-time +20 EazeScore on first login |
| GET | `/api/score/:eazeUserId` | Lifetime EazeScore total, sessions completed, current day streak |
