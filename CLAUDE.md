# Prestisa Sales AI Agent — "Tiara"

Pilot project: customer-facing WhatsApp sales agent for Prestisa (toko bunga online — papan, bouquet, parsel, cake). Hosted standalone in this folder, sibling to `/home/krttpt/konsumen/` and `/home/krttpt/mitra/`.

## Status

- ✅ Brainstorming complete (in previous Claude session, working dir `/home/krttpt/konsumen`)
- ✅ Design spec written and committed: `docs/specs/2026-05-01-sales-ai-agent-design.md`
- ⏳ **Next: writing-plans skill → implementation plan per file/task with checkpoints**
- ⏳ Then: scaffold project, implement per plan
- ⏳ Sub-spec follow-ups: promo settings dashboard; FAQ refresh pipeline

When starting a new session here, read the spec first. Then either:
- "Lanjut ke writing-plans" (recommended next step)
- Or specific change to spec, then re-review

## Project context (carry-over from brainstorm)

**Goal.** AI agent (named "Tiara") that handles inbound WhatsApp from customers — answers product/pricing/shipping/order-status questions, drives closing via prefilled order form URL, and hands over to human operator on complaint/refund/cancel/low-confidence.

**Volume baseline (from `vonage_wa_messages` 30d analysis at brainstorm time):** ~5,700 inbound msg/day, ~350 unique customers/day. Top themes: order_intent (6.7%), shipping/delivery (6.4%), order_status (6.3%), payment (3.6%), pricing (3.4%).

**Skenario peran AI** = D (AI-first with low-confidence fallback) + sales human can monitor & take over manually + closing = order form submission.

**Persona** = "Tiara", santai-sopan, sapaan "Kak", confidence threshold rendah (sering eskalasi, aman).

**Stack chosen.**
- Node Express + Next.js + PostgreSQL + MySQL (mirror `mitra/crm-backend` pattern)
- WhatsApp via **WAHA** (self-hosted, reuse from `mitra/crm-backend/services/waha.js`)
- Provider abstraction layer (`waClient.js` + adapters) so Phase 2 can swap to Meta Cloud API
- LLM: **Claude Sonnet 4.6** (reply) + **Gemini 2.5 Flash** (pre-classifier guardrail)
- DB: PG `vonage_reports` (existing) with `crm_*` table prefix — no new database

## Repo layout (per spec)

```
crm/
├── docs/
│   ├── specs/
│   │   └── 2026-05-01-sales-ai-agent-design.md   # design spec
│   └── decisions/                                # ADRs (future)
├── backend/
│   ├── routes/      # webhook, inbox, admin, auth, health
│   ├── services/    # aiAgent, aiTools, aiPersona, aiGuardrails, aiConfidence,
│   │                # claudeClient, geminiClient, waClient + waAdapters/, contactResolver, notify
│   ├── db/          # postgres.js, mysql.js
│   ├── middleware/  # auth.js
│   └── migrations/  # SQL files (001_init.sql, 002_seed_persona.sql, ...)
└── frontend/        # Next.js: /inbox, /inbox/[id], /ai-monitor, /ai-settings
```

## Existing reusable code on this VPS

- **WAHA wrapper:** `/home/krttpt/mitra/crm-backend/services/waha.js` (72 lines) + `routes/waha.js` (592 lines) — webhook, send, media. Adapt for customer-side, swap into `waAdapters/wahaAdapter.js`.
- **Gemini tool calling:** `/home/krttpt/mitra/crm-backend/services/gemini.js` — `generateWithTools` loop. Reference for `geminiClient.js` (classifier role only) and `claudeClient.js` (similar pattern with Anthropic SDK).
- **Tool executor pattern:** `/home/krttpt/mitra/crm-backend/services/customer-tools.js` and `mitra-tools.js` — function declarations with declarations + executor map.
- **Auth:** session-based, mirror `/home/krttpt/konsumen/backend/routes/auth.js` and `/home/krttpt/mitra/crm-backend/routes/auth.js`.
- **Vonage HSM outbound (HSM blasts only, NOT for this project's customer chat):** `/home/krttpt/konsumen/backend/services/` — out of scope here, do not reuse for inbound agent.

## Database access

- **PostgreSQL:** `vonage_reports` database, host `localhost:5432`, user `vonage_sync`. Credentials in `/home/krttpt/mitra/.env` and `/home/krttpt/konsumen/backend/.env`. New tables prefixed `crm_*`.
- **MySQL:** read-only access to `prestisa` DB for `products`, `product_category_new`, `city`, `customer`, `order`, `order_items`, `purchase_order`. Credentials in same `.env` files.

## Memory & user context (auto-memory)

This project's auto-memory will live at `~/.claude/projects/-home-krttpt-crm/memory/`. To bring user/feedback memory from the konsumen session:

```bash
mkdir -p ~/.claude/projects/-home-krttpt-crm/memory
cp ~/.claude/projects/-home-krttpt-konsumen/memory/{user_*,feedback_*}.md \
   ~/.claude/projects/-home-krttpt-crm/memory/ 2>/dev/null
```

User: finance.parselia@gmail.com. Web server on this VPS = **Caddy** (`/etc/caddy/Caddyfile`), never nginx.

## What this folder is NOT

- Not the existing mitra CRM (that's `/home/krttpt/mitra/`)
- Not the consumer analytics dashboard (that's `/home/krttpt/konsumen/`)
- Not built yet — spec is here, code is not. Start by reading the spec.

## Next session — recommended first action

```
Skill: superpowers:writing-plans
Input: docs/specs/2026-05-01-sales-ai-agent-design.md
```

This generates step-by-step implementation plan with file-level tasks, dependencies, and checkpoint tests.
