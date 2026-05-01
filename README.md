# Prestisa Sales AI Agent — "Tiara"

Customer-facing WhatsApp sales AI agent for Prestisa. Pilot project.

- **Spec:** [`docs/specs/2026-05-01-sales-ai-agent-design.md`](docs/specs/2026-05-01-sales-ai-agent-design.md)
- **Plan A (backend):** [`docs/superpowers/plans/2026-05-01-sales-ai-agent-plan-a-backend.md`](docs/superpowers/plans/2026-05-01-sales-ai-agent-plan-a-backend.md)
- **Deployment:** [`docs/deployment.md`](docs/deployment.md)

## Quick start (dev)

```bash
cp .env.example .env       # fill secrets
cd backend
npm install
npm run migrate
npm run seed:staff
npm test                   # full suite
npm start                  # listens on :3009
```

## Architecture

Inbound WAHA webhook → idempotent enqueue (PG) → in-process worker polls
queue → Gemini Flash pre-classifier (handover dangerous intents) → Claude
Sonnet with tool-call loop (catalog, shipping, promos, FAQ, orders,
order-form-url, request_handover) → post-check + confidence scorer →
WAHA send (or shadow mode) → Socket.IO push to operator UI.

## Tech

Node 20, Express 5, PostgreSQL, MySQL (read-only), Anthropic + Google
Generative AI SDKs, Socket.IO, JWT cookie auth, pino, Jest.

## Ops

- PM2 fork mode (worker holds queue lock — single instance only)
- Caddy reverse proxy on `salesai.prestisa.net`
- Daily metrics rollup cron at 00:30
- Admin UI for WAHA session provisioning at `/admin/waha-sessions.html`
