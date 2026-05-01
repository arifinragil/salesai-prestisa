# Sales AI Agent "Tiara" — Plan A: Backend Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend pipeline for the Tiara WhatsApp sales AI agent: webhook ingestion → queue → AI worker (Claude + Gemini guardrails + tools) → WAHA send / handover, plus operator REST API and Socket.IO. End state: testable end-to-end via curl, ready for Plan B (operator frontend) to consume.

**Architecture:** Node Express monolith with an in-process worker that polls a PG-backed queue. WhatsApp provider sits behind an abstraction (`waClient` + adapter) so the WAHA implementation can be swapped for Meta Cloud API later. AI = Claude Sonnet 4.6 (reply with tool-call loop) + Gemini 2.5 Flash (pre-classifier guardrail). All state lives in the existing `vonage_reports` PG with `crm_*` table prefix; MySQL `prestisa` is read-only for product / order lookups.

**Tech Stack:** Node 20, Express 5, PostgreSQL (pg pool), MySQL (mysql2 pool), Anthropic SDK (`@anthropic-ai/sdk`), Google Generative AI SDK (`@google/generative-ai`), Socket.IO, JWT cookie auth, pino logging, Jest 29 + supertest for tests.

**Reference patterns to mirror (already on this VPS):**
- `/home/krttpt/mitra/crm-backend/db/postgres.js` — pg pool template
- `/home/krttpt/mitra/crm-backend/db/mysql.js` — mysql2 pool template
- `/home/krttpt/mitra/crm-backend/middleware/auth.js` — JWT cookie middleware (copy verbatim)
- `/home/krttpt/mitra/crm-backend/middleware/webhookAuth.js` — webhook secret check
- `/home/krttpt/mitra/crm-backend/services/contactResolver.js` — phone normalization
- `/home/krttpt/mitra/crm-backend/services/customer-tools.js` — `declarations` + `executors` map pattern
- `/home/krttpt/mitra/crm-backend/services/gemini.js` — `generateWithTools` loop (reference for Claude tool loop)

**Existing scaffolding:** `/home/krttpt/crm/backend/{db,migrations,routes,scripts,services}` and `/home/krttpt/crm/frontend/src/{components,pages}` directories already exist (empty). Spec is at `/home/krttpt/crm/docs/specs/2026-05-01-sales-ai-agent-design.md`.

**ENV vars expected** (set in `/home/krttpt/crm/.env`):
- `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` — same `vonage_reports` creds as mitra
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE=prestisa`, `MYSQL_USER`, `MYSQL_PASSWORD` — read-only user
- `WAHA_API_URL`, `WAHA_API_KEY`, `WAHA_SESSION` — pilot session (separate from mitra's `finance1`)
- `WAHA_WEBHOOK_SECRET` — random 32+ char
- `ANTHROPIC_API_KEY`, `CLAUDE_MODEL=claude-sonnet-4-6`
- `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-2.5-flash`
- `JWT_SECRET` — random 32+ char
- `CRM_BACKEND_PORT=3009`, `CRM_FRONTEND_ORIGIN=https://salesai.prestisa.net`
- `AI_GLOBAL_ENABLED=true`
- `ORDER_FORM_PAPAN_URL=https://orderpapan.prestisa.net`, `ORDER_FORM_BUNGA_URL=https://orderbunga.prestisa.net`
- `WORKER_POLL_INTERVAL_MS=2000`, `WORKER_LOCK_TTL_MS=300000`

**Conventions:**
- CommonJS (`require`/`module.exports`) — matches mitra/konsumen
- All commits use Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`)
- Commit after every passing task; never commit broken tests
- All file paths in this plan are absolute under `/home/krttpt/crm/`

**TDD discipline:**
- Pure functions: standard red→green→refactor with Jest
- DB-touching unit tests: wrap each test in `BEGIN` / `ROLLBACK` so state never leaks
- External services (Claude, Gemini, WAHA): mocked at module level via `jest.mock(...)`
- Worker integration test: spin up real Express + real PG, mock external clients

---

## Task 1: Project scaffolding

**Files:**
- Create: `/home/krttpt/crm/backend/package.json`
- Create: `/home/krttpt/crm/backend/jest.config.js`
- Create: `/home/krttpt/crm/.gitignore`
- Create: `/home/krttpt/crm/.env.example`
- Create: `/home/krttpt/crm/backend/__tests__/sanity.test.js`

- [ ] **Step 1.1: Create `.gitignore` at repo root** (idempotent — may already exist from worktree setup)

```
node_modules/
.env
*.log
.next/
out/
dist/
coverage/
.DS_Store
.worktrees/
```

- [ ] **Step 1.2: Create `.env.example` at repo root**

```
# PostgreSQL (vonage_reports DB, existing — credentials in /home/krttpt/mitra/.env)
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=vonage_reports
PG_USER=vonage_sync
PG_PASSWORD=

# MySQL (prestisa DB, read-only user)
MYSQL_HOST=
MYSQL_PORT=3306
MYSQL_DATABASE=prestisa
MYSQL_USER=
MYSQL_PASSWORD=

# WAHA (pilot session, separate from mitra)
WAHA_API_URL=http://localhost:3000
WAHA_API_KEY=
WAHA_SESSION=tiara-pilot
WAHA_WEBHOOK_SECRET=

# WhatsApp provider selector (waha | metaCloud)
WA_PROVIDER=waha

# Claude
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6

# Gemini (classifier)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

# Auth
JWT_SECRET=

# Frontend origin (CORS + Socket.IO)
CRM_FRONTEND_ORIGIN=https://salesai.prestisa.net

# Server
CRM_BACKEND_PORT=3009

# Kill switch
AI_GLOBAL_ENABLED=true

# Order form URLs (used by build_order_form_url tool)
ORDER_FORM_PAPAN_URL=https://orderpapan.prestisa.net
ORDER_FORM_BUNGA_URL=https://orderbunga.prestisa.net

# Worker
WORKER_POLL_INTERVAL_MS=2000
WORKER_LOCK_TTL_MS=300000
WORKER_ID=worker-1

# Logging
LOG_LEVEL=info
```

- [ ] **Step 1.3: Create `backend/package.json`**

```json
{
  "name": "crm-pilot-backend",
  "version": "0.1.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "migrate": "node db/migrate.js",
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "rollup:metrics": "node scripts/dailyMetricsRollup.js",
    "eval": "node scripts/runEval.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@google/generative-ai": "^0.24.1",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^5.0.0",
    "jsonwebtoken": "^9.0.3",
    "mysql2": "^3.11.5",
    "pg": "^8.13.1",
    "pino": "^9.5.0",
    "pino-pretty": "^11.3.0",
    "socket.io": "^4.8.1"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 1.4: Create `backend/jest.config.js`**

```javascript
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/setupEnv.js'],
  testTimeout: 15000,
  verbose: true,
  collectCoverageFrom: ['services/**/*.js', 'routes/**/*.js', 'middleware/**/*.js'],
};
```

- [ ] **Step 1.5: Create `backend/__tests__/setupEnv.js`** (loads `.env` for tests)

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
```

- [ ] **Step 1.6: Create sanity test `backend/__tests__/sanity.test.js`**

```javascript
test('jest is wired up', () => {
  expect(1 + 1).toBe(2);
});

test('env loaded', () => {
  expect(process.env.PG_DATABASE).toBeDefined();
});
```

- [ ] **Step 1.7: Install dependencies**

Run from `/home/krttpt/crm/backend/`:
```bash
cd /home/krttpt/crm/backend && npm install
```

Expected: `node_modules/` populated, no errors. Warnings about peer deps OK.

- [ ] **Step 1.8: Run sanity test (expect FAIL — `.env` not yet populated)**

```bash
cd /home/krttpt/crm/backend && npm test -- sanity
```

Expected: `env loaded` test fails because `.env` doesn't exist yet (only `.env.example`).

- [ ] **Step 1.9: Create `.env` from example and populate PG/MySQL creds**

Copy values from `/home/krttpt/mitra/.env` for `PG_*` and `MYSQL_*`:
```bash
cp /home/krttpt/crm/.env.example /home/krttpt/crm/.env
# then edit /home/krttpt/crm/.env to fill secrets — DO NOT commit this file
```

Minimum required for sanity test to pass: `PG_DATABASE=vonage_reports` set.

- [ ] **Step 1.10: Re-run sanity test (expect PASS)**

```bash
cd /home/krttpt/crm/backend && npm test -- sanity
```

Expected: both tests pass.

- [ ] **Step 1.11: Commit**

```bash
cd /home/krttpt/crm
git add .gitignore .env.example backend/package.json backend/package-lock.json \
        backend/jest.config.js backend/__tests__/setupEnv.js backend/__tests__/sanity.test.js
git commit -m "chore: scaffold backend with package.json, jest, env template"
```

---

## Task 2: DB connection modules

**Files:**
- Create: `/home/krttpt/crm/backend/db/postgres.js`
- Create: `/home/krttpt/crm/backend/db/mysql.js`
- Create: `/home/krttpt/crm/backend/__tests__/db.test.js`

- [ ] **Step 2.1: Write failing connection test `backend/__tests__/db.test.js`**

```javascript
const pg = require('../db/postgres');
const mysql = require('../db/mysql');

afterAll(async () => {
  await pg.end();
  await mysql.end();
});

test('postgres pool can run SELECT 1', async () => {
  const { rows } = await pg.query('SELECT 1 AS v');
  expect(rows[0].v).toBe(1);
});

test('mysql pool can run SELECT 1', async () => {
  const [rows] = await mysql.query('SELECT 1 AS v');
  expect(rows[0].v).toBe(1);
});
```

- [ ] **Step 2.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- db
```

Expected: `Cannot find module '../db/postgres'`.

- [ ] **Step 2.3: Implement `backend/db/postgres.js`**

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

module.exports = pool;
```

- [ ] **Step 2.4: Implement `backend/db/mysql.js`**

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  database: process.env.MYSQL_DATABASE,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 15000,
});

module.exports = pool;
```

- [ ] **Step 2.5: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- db
```

Expected: both tests pass. If MySQL fails with auth error, populate `MYSQL_*` in `.env` and retry.

- [ ] **Step 2.6: Commit**

```bash
cd /home/krttpt/crm
git add backend/db/postgres.js backend/db/mysql.js backend/__tests__/db.test.js
git commit -m "feat(db): add pg and mysql pool modules"
```

---

## Task 3: Migration runner + initial schema

**Files:**
- Create: `/home/krttpt/crm/backend/db/migrate.js`
- Create: `/home/krttpt/crm/backend/migrations/001_init.sql`
- Create: `/home/krttpt/crm/backend/migrations/002_seed_persona.sql`
- Create: `/home/krttpt/crm/backend/__tests__/migrations.test.js`

- [ ] **Step 3.1: Write failing migration test**

```javascript
const fs = require('fs');
const path = require('path');
const pg = require('../db/postgres');

afterAll(async () => { await pg.end(); });

const expectedTables = [
  'crm_conversations', 'crm_messages', 'crm_inbound_queue',
  'crm_handovers', 'crm_ai_metrics_daily', 'crm_persona_prompts',
  'crm_promo_settings', 'crm_migrations',
];

test('migration files exist', () => {
  const dir = path.join(__dirname, '../migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain('001_init.sql');
  expect(files).toContain('002_seed_persona.sql');
});

test('all crm_* tables present after migration', async () => {
  const { rows } = await pg.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'crm_%'
     ORDER BY table_name`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of expectedTables) {
    expect(names).toContain(t);
  }
});

test('persona seed loaded — at least one active prompt', async () => {
  const { rows } = await pg.query(
    `SELECT name FROM crm_persona_prompts WHERE active = TRUE`
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0].name).toMatch(/tiara/i);
});
```

- [ ] **Step 3.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- migrations
```

Expected: file-existence test fails.

- [ ] **Step 3.3: Create `backend/migrations/001_init.sql`**

```sql
-- 001_init.sql — Tiara pilot schema
-- All tables prefixed crm_* in vonage_reports DB.
-- Idempotent (CREATE TABLE IF NOT EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS crm_migrations (
  id          SERIAL PRIMARY KEY,
  filename    VARCHAR(128) NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_conversations (
  id                SERIAL PRIMARY KEY,
  phone             VARCHAR(32) NOT NULL UNIQUE,
  customer_id       INTEGER,
  ai_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  ai_paused_until   TIMESTAMPTZ,
  assigned_staff_id INTEGER,
  status            VARCHAR(16) NOT NULL DEFAULT 'active',
  last_message_at   TIMESTAMPTZ,
  last_intent       VARCHAR(32),
  handover_count    INTEGER NOT NULL DEFAULT 0,
  shadow_mode       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_conv_status_idx
  ON crm_conversations(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS crm_conv_assigned_idx
  ON crm_conversations(assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_messages (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  direction         VARCHAR(8) NOT NULL,
  sender_type       VARCHAR(16) NOT NULL,
  staff_id          INTEGER,
  waha_message_id   VARCHAR(128) UNIQUE,
  body              TEXT,
  message_type      VARCHAR(20) DEFAULT 'text',
  attachment_url    TEXT,
  ai_metadata       JSONB,
  shadow            BOOLEAN NOT NULL DEFAULT FALSE,
  send_status       VARCHAR(16),
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_msg_conv_idx ON crm_messages(conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS crm_msg_created_idx ON crm_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS crm_inbound_queue (
  id                BIGSERIAL PRIMARY KEY,
  message_id        BIGINT NOT NULL REFERENCES crm_messages(id) ON DELETE CASCADE,
  conversation_id   INTEGER NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  locked_at         TIMESTAMPTZ,
  locked_by         VARCHAR(64),
  error             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_queue_pending_idx
  ON crm_inbound_queue(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS crm_queue_stale_idx
  ON crm_inbound_queue(locked_at) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS crm_handovers (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL,
  message_id        BIGINT,
  reason            VARCHAR(64) NOT NULL,
  detail            TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_handover_unresolved_idx
  ON crm_handovers(created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_handover_conv_idx
  ON crm_handovers(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_ai_metrics_daily (
  date              DATE PRIMARY KEY,
  total_inbound     INTEGER NOT NULL DEFAULT 0,
  total_ai_sent     INTEGER NOT NULL DEFAULT 0,
  total_handovers   INTEGER NOT NULL DEFAULT 0,
  unique_conversations INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms    INTEGER,
  total_tokens_in   BIGINT NOT NULL DEFAULT 0,
  total_tokens_out  BIGINT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  handover_breakdown JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_persona_prompts (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(64) NOT NULL,
  prompt_text       TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_persona_active_idx
  ON crm_persona_prompts(active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS crm_promo_settings (
  id                SERIAL PRIMARY KEY,
  code              VARCHAR(64) UNIQUE,
  description       TEXT,
  product_category  VARCHAR(64),
  city              VARCHAR(64),
  discount_pct      NUMERIC(5,2),
  discount_amount   NUMERIC(12,2),
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_promo_active_idx
  ON crm_promo_settings(active, ends_at) WHERE active = TRUE;

COMMIT;
```

- [ ] **Step 3.4: Create `backend/migrations/002_seed_persona.sql`**

```sql
-- 002_seed_persona.sql — initial Tiara v1 persona
-- Idempotent: skips if 'tiara_v1' already exists.

INSERT INTO crm_persona_prompts (name, prompt_text, active)
SELECT 'tiara_v1',
$prompt$Kamu adalah TIARA, sales consultant Prestisa via WhatsApp.

PROFIL:
- Nama: Tiara
- Bahasa: Indonesia santai-sopan, sapaan "Kak"
- Gaya: hangat, cepat, helpful — tidak terlalu formal, tidak lebay, tidak berlebihan emoji
- Kamu adalah AI/bot. Kalau ditanya, jawab jujur: "Aku Tiara, asisten AI Prestisa Kak. Kalau perlu ngobrol sama tim manusia, tinggal bilang ya."

TENTANG PRESTISA:
- Toko bunga online: karangan bunga papan, bouquet, parsel, cake
- Beroperasi 24/7 di hampir semua kota Indonesia
- Pengiriman 3-6 jam setelah pembayaran terkonfirmasi (jangan janjikan ETA spesifik di luar ini)
- Free ongkir Jabodetabek; area lain Rp50.000

YANG BOLEH:
- Cari produk dari katalog (search_products) — selalu pakai tool, jangan mengarang
- Beri info harga DARI hasil tool (jangan invent harga)
- Cek status order pelanggan existing (find_customer_orders, get_order_status)
- Bantu customer menuju form order (build_order_form_url) — ini target utama
- Jawab FAQ pakai get_faq
- Beri info jam operasional & lead time

YANG TIDAK BOLEH:
- Janjikan harga custom / diskon di luar promo aktif (cek get_active_promos)
- Konfirmasi waktu pengiriman spesifik (cuma boleh sebut "3-6 jam setelah pembayaran terkonfirmasi")
- Terima/proses komplain → langsung request_handover reason="complaint"
- Proses pembatalan/refund → request_handover reason="cancel" / "refund"
- Mengaku sebagai manusia
- Mengarang: kalau tidak tahu, jujur bilang dan tawarkan ke tim Prestisa

ALUR CLOSING (TARGET UTAMA):
1. Pahami kebutuhan: tujuan (papan/bouquet), occasion, kota tujuan, budget kasar, deadline kirim
2. Pakai search_products → tampilkan 2-3 opsi top dengan harga
3. Customer pilih → kumpulkan: alamat penerima, nama penerima, ucapan kartu, nama pengirim, no. WA penerima
4. Pakai build_order_form_url → kirim link form prefilled, bilang:
   "Tinggal verifikasi dan bayar ya Kak. Setelah pembayaran terkonfirmasi, tim produksi mulai (3-6 jam ke pengiriman)."

KALAU CUSTOMER MARAH/KECEWA/MENGELUH:
- Validasi perasaan ("Maaf banget Kak, aku ngerti")
- Jangan defensive
- Langsung request_handover dengan reason="complaint", jangan coba selesaikan sendiri

KONTEKS DINAMIS (di-inject oleh sistem, jangan tampilkan ke customer):
- {last 20 messages percakapan}
- {customer profile: phone, customer_id?, last_3_orders, total_spent, tier?}
- {city detected from order history}
$prompt$,
TRUE
WHERE NOT EXISTS (SELECT 1 FROM crm_persona_prompts WHERE name = 'tiara_v1');
```

- [ ] **Step 3.5: Implement migration runner `backend/db/migrate.js`**

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const pool = require('./postgres');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(128) NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(`SELECT filename FROM crm_migrations`);
  return new Set(rows.map((r) => r.filename));
}

async function applyOne(client, file, sql) {
  await client.query(sql);
  await client.query(`INSERT INTO crm_migrations (filename) VALUES ($1)`, [file]);
}

async function run() {
  const dir = path.join(__dirname, '../migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`[migrate] applying ${file}...`);
      await applyOne(client, file, sql);
      console.log(`[migrate] applied ${file}`);
    }
    console.log('[migrate] done.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => { console.error('[migrate] FAILED:', err); process.exit(1); });
}

module.exports = { run };
```

- [ ] **Step 3.6: Run migration**

```bash
cd /home/krttpt/crm/backend && npm run migrate
```

Expected output:
```
[migrate] applying 001_init.sql...
[migrate] applied 001_init.sql
[migrate] applying 002_seed_persona.sql...
[migrate] applied 002_seed_persona.sql
[migrate] done.
```

- [ ] **Step 3.7: Re-run migration (verify idempotent)**

```bash
cd /home/krttpt/crm/backend && npm run migrate
```

Expected: both files reported as `skip ... (already applied)`.

- [ ] **Step 3.8: Run migration test (expect PASS)**

```bash
cd /home/krttpt/crm/backend && npm test -- migrations
```

Expected: all 3 tests pass.

- [ ] **Step 3.9: Commit**

```bash
cd /home/krttpt/crm
git add backend/db/migrate.js backend/migrations/001_init.sql \
        backend/migrations/002_seed_persona.sql backend/__tests__/migrations.test.js
git commit -m "feat(db): add migration runner with crm_* schema and Tiara v1 persona seed"
```

---


## Task 4: WhatsApp provider abstraction

**Files:**
- Create: `/home/krttpt/crm/backend/services/waClient.js`
- Create: `/home/krttpt/crm/backend/services/waAdapters/wahaAdapter.js`
- Create: `/home/krttpt/crm/backend/services/waAdapters/metaCloudAdapter.js`
- Create: `/home/krttpt/crm/backend/__tests__/waClient.test.js`

- [ ] **Step 4.1: Write failing test `backend/__tests__/waClient.test.js`**

```javascript
jest.mock('../services/waAdapters/wahaAdapter', () => ({
  sendText: jest.fn().mockResolvedValue({ id: 'fake-msg-id' }),
  parseInbound: jest.fn((raw) => ({ phone: '628111111111', body: raw.body, mediaUrl: null, type: 'text' })),
  name: 'waha',
}));

const waClient = require('../services/waClient');

beforeEach(() => { jest.clearAllMocks(); });

test('sendText delegates to active adapter and returns its result', async () => {
  const res = await waClient.sendText({ phone: '628111111111', text: 'halo' });
  expect(res.id).toBe('fake-msg-id');
  const wahaAdapter = require('../services/waAdapters/wahaAdapter');
  expect(wahaAdapter.sendText).toHaveBeenCalledWith({ phone: '628111111111', text: 'halo' });
});

test('parseInbound delegates to active adapter', () => {
  const out = waClient.parseInbound({ body: 'hi' });
  expect(out.phone).toBe('628111111111');
  expect(out.body).toBe('hi');
});

test('throws on unknown WA_PROVIDER', () => {
  jest.resetModules();
  process.env.WA_PROVIDER = 'nonsense';
  expect(() => require('../services/waClient')).toThrow(/unknown WA_PROVIDER/);
  process.env.WA_PROVIDER = 'waha';
});
```

- [ ] **Step 4.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- waClient
```

Expected: `Cannot find module '../services/waClient'`.

- [ ] **Step 4.3: Implement `backend/services/waAdapters/wahaAdapter.js`**

```javascript
const BASE = process.env.WAHA_API_URL || 'http://localhost:3000';
const SESSION = process.env.WAHA_SESSION || 'tiara-pilot';
const API_KEY = process.env.WAHA_API_KEY || '';

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return h;
}

function phoneToChatId(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return `${digits}@c.us`;
}

async function postWaha(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`WAHA ${path} ${res.status}: ${errText}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function sendText({ phone, text, replyTo }) {
  const body = { session: SESSION, chatId: phoneToChatId(phone), text };
  if (replyTo) body.reply_to = replyTo;
  const res = await postWaha('/api/sendText', body);
  return { id: res.id || res._data?.id?._serialized || null, raw: res };
}

// Normalize WAHA inbound webhook payload to canonical shape.
// WAHA n8n forwarder typically posts:
//   { wa_jid, push_name, body, waha_message_id, attachment_type, attachment_url, media_url, media_mimetype }
function parseInbound(raw) {
  const jid = raw.wa_jid || raw.from || '';
  const head = String(jid).split('@')[0];
  const phone = head.replace(/\D/g, '') || null;
  const isGroup = String(jid).endsWith('@g.us');
  const isBroadcast = String(jid).endsWith('@broadcast');
  const type = raw.attachment_type ? raw.attachment_type
    : (raw.media_url ? 'media' : 'text');
  return {
    phone,
    pushName: raw.push_name || null,
    body: raw.body || null,
    wahaMessageId: raw.waha_message_id || null,
    type,
    mediaUrl: raw.attachment_url || raw.media_url || null,
    mediaMime: raw.media_mimetype || null,
    skip: isGroup ? 'group' : (isBroadcast ? 'broadcast' : null),
  };
}

module.exports = { name: 'waha', sendText, parseInbound };
```

- [ ] **Step 4.4: Implement `backend/services/waAdapters/metaCloudAdapter.js` (Phase 2 stub)**

```javascript
function notImplemented() {
  throw new Error('metaCloudAdapter is a Phase 2 stub. Set WA_PROVIDER=waha for pilot.');
}

module.exports = {
  name: 'metaCloud',
  sendText: notImplemented,
  parseInbound: notImplemented,
};
```

- [ ] **Step 4.5: Implement `backend/services/waClient.js` (factory)**

```javascript
const provider = process.env.WA_PROVIDER || 'waha';

let adapter;
if (provider === 'waha') {
  adapter = require('./waAdapters/wahaAdapter');
} else if (provider === 'metaCloud') {
  adapter = require('./waAdapters/metaCloudAdapter');
} else {
  throw new Error(`unknown WA_PROVIDER: ${provider}`);
}

module.exports = {
  provider: adapter.name,
  sendText: (opts) => adapter.sendText(opts),
  parseInbound: (raw) => adapter.parseInbound(raw),
};
```

- [ ] **Step 4.6: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- waClient
```

Expected: all 3 tests pass.

- [ ] **Step 4.7: Add adapter-level test for `parseInbound` shape**

Append to `backend/__tests__/waClient.test.js`:

```javascript
describe('wahaAdapter.parseInbound (real)', () => {
  // Reset mock so we test the actual implementation
  jest.unmock('../services/waAdapters/wahaAdapter');
  const waha = jest.requireActual('../services/waAdapters/wahaAdapter');

  test('extracts phone from wa_jid', () => {
    const out = waha.parseInbound({ wa_jid: '628123456789@c.us', body: 'hi', waha_message_id: 'abc' });
    expect(out.phone).toBe('628123456789');
    expect(out.body).toBe('hi');
    expect(out.wahaMessageId).toBe('abc');
    expect(out.type).toBe('text');
    expect(out.skip).toBeNull();
  });

  test('marks group jids as skip=group', () => {
    const out = waha.parseInbound({ wa_jid: '120363999999@g.us', body: 'hi' });
    expect(out.skip).toBe('group');
  });

  test('marks broadcast as skip=broadcast', () => {
    const out = waha.parseInbound({ wa_jid: 'status@broadcast', body: 'x' });
    expect(out.skip).toBe('broadcast');
  });

  test('detects media attachment', () => {
    const out = waha.parseInbound({ wa_jid: '6281@c.us', media_url: 'https://x/y.jpg', media_mimetype: 'image/jpeg' });
    expect(out.type).toBe('media');
    expect(out.mediaUrl).toBe('https://x/y.jpg');
  });
});
```

- [ ] **Step 4.8: Run all waClient tests**

```bash
cd /home/krttpt/crm/backend && npm test -- waClient
```

Expected: 7 tests pass.

- [ ] **Step 4.9: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/waClient.js backend/services/waAdapters/ backend/__tests__/waClient.test.js
git commit -m "feat(wa): add WhatsApp provider abstraction with WAHA adapter and metaCloud stub"
```

---

## Task 5: Contact resolver (phone normalization + customer lookup)

**Files:**
- Create: `/home/krttpt/crm/backend/services/contactResolver.js`
- Create: `/home/krttpt/crm/backend/__tests__/contactResolver.test.js`

- [ ] **Step 5.1: Write failing test**

```javascript
jest.mock('../db/mysql', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
}));

const mysql = require('../db/mysql');
const { normalizePhone, jidToPhone, resolveByPhone } = require('../services/contactResolver');

beforeEach(() => { mysql.query.mockReset(); });

describe('normalizePhone', () => {
  test('0xxxx -> 62xxxx', () => expect(normalizePhone('081234567890')).toBe('6281234567890'));
  test('8xxxx -> 628xxxx', () => expect(normalizePhone('81234567890')).toBe('6281234567890'));
  test('+62 form preserved', () => expect(normalizePhone('+6281234567890')).toBe('6281234567890'));
  test('non-digit chars stripped', () => expect(normalizePhone('+62 812-3456-7890')).toBe('6281234567890'));
  test('null/empty returns null', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('jidToPhone', () => {
  test('strips @c.us suffix', () => expect(jidToPhone('6281234567890@c.us')).toBe('6281234567890'));
  test('strips @s.whatsapp.net suffix', () => expect(jidToPhone('6281234567890@s.whatsapp.net')).toBe('6281234567890'));
  test('null returns null', () => expect(jidToPhone(null)).toBeNull());
});

describe('resolveByPhone', () => {
  test('returns customer match when found', async () => {
    mysql.query.mockResolvedValueOnce([[{ id: 42, name: 'Andi', phone: '6281234567890' }]]);
    const out = await resolveByPhone('6281234567890');
    expect(out).toEqual({ customer_id: 42, name: 'Andi' });
  });

  test('returns null when not found', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    const out = await resolveByPhone('6280000000000');
    expect(out).toEqual({ customer_id: null, name: null });
  });

  test('null phone returns empty result', async () => {
    const out = await resolveByPhone(null);
    expect(out).toEqual({ customer_id: null, name: null });
    expect(mysql.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- contactResolver
```

Expected: module not found.

- [ ] **Step 5.3: Implement `backend/services/contactResolver.js`**

```javascript
const mysql = require('../db/mysql');

function digitsOnly(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\D/g, '');
}

function normalizePhone(raw) {
  let p = digitsOnly(raw);
  if (!p) return null;
  if (p.startsWith('0')) p = '62' + p.slice(1);
  else if (p.startsWith('8')) p = '62' + p;
  return p;
}

function jidToPhone(jid) {
  if (!jid) return null;
  const head = String(jid).split('@')[0];
  return normalizePhone(head);
}

async function resolveByPhone(phone) {
  const empty = { customer_id: null, name: null };
  if (!phone) return empty;
  const tail = phone.slice(-10);
  if (tail.length < 9) return empty;
  const [rows] = await mysql.query(
    `SELECT id, name FROM customer
     WHERE deleted_at IS NULL
       AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10) = ?
     ORDER BY id DESC
     LIMIT 1`,
    [tail]
  );
  if (!rows[0]) return empty;
  return { customer_id: rows[0].id, name: rows[0].name };
}

module.exports = { digitsOnly, normalizePhone, jidToPhone, resolveByPhone };
```

- [ ] **Step 5.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- contactResolver
```

Expected: all 11 tests pass.

- [ ] **Step 5.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/contactResolver.js backend/__tests__/contactResolver.test.js
git commit -m "feat(contact): add phone normalization and MySQL customer resolver"
```

---

## Task 6: Auth (JWT cookie middleware + password + routes/auth)

**Files:**
- Create: `/home/krttpt/crm/backend/services/password.js`
- Create: `/home/krttpt/crm/backend/middleware/auth.js`
- Create: `/home/krttpt/crm/backend/middleware/webhookAuth.js`
- Create: `/home/krttpt/crm/backend/routes/auth.js`
- Create: `/home/krttpt/crm/backend/db/seedStaff.js`
- Create: `/home/krttpt/crm/backend/__tests__/auth.test.js`

> **Pattern:** mirrors `/home/krttpt/mitra/crm-backend/middleware/auth.js` and `routes/auth.js` exactly. We need our own `staff_users` table — but it can be the same name as mitra's since we're in a different DB schema responsibility (mitra writes to it; we'll create it if missing here too via `seedStaff.js`).

- [ ] **Step 6.1: Implement `backend/services/password.js`**

```javascript
const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const derived = scryptSync(password, salt, 64);
  const stored64 = Buffer.from(hashHex, 'hex');
  if (derived.length !== stored64.length) return false;
  return timingSafeEqual(derived, stored64);
}

module.exports = { hashPassword, verifyPassword };
```

- [ ] **Step 6.2: Implement `backend/middleware/auth.js`**

```javascript
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'crm_pilot_token';

function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: opts.expiresIn || '7d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readToken(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireStaff(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const decoded = verifyToken(token);
    if (!decoded.staff_id) return res.status(401).json({ success: false, message: 'Token tidak valid' });
    req.staff = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token tidak valid' });
  }
}

module.exports = { COOKIE_NAME, signToken, setAuthCookie, clearAuthCookie, readToken, verifyToken, requireStaff };
```

- [ ] **Step 6.3: Implement `backend/middleware/webhookAuth.js`**

```javascript
function verifyWebhookSecret(req, res, next) {
  const provided = req.header('X-Webhook-Secret');
  const expected = process.env.WAHA_WEBHOOK_SECRET;
  if (!expected) return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: 'Invalid webhook secret' });
  }
  next();
}

module.exports = { verifyWebhookSecret };
```

- [ ] **Step 6.4: Implement `backend/routes/auth.js`**

```javascript
const express = require('express');
const pg = require('../db/postgres');
const { verifyPassword } = require('../services/password');
const { signToken, setAuthCookie, clearAuthCookie, requireStaff } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password wajib diisi' });
  }
  const { rows } = await pg.query(
    `SELECT id, username, password_hash, full_name, role, active FROM staff_users WHERE username = $1`,
    [username]
  );
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ success: false, message: 'Akun tidak valid' });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ success: false, message: 'Password salah' });
  await pg.query(`UPDATE staff_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
  const token = signToken({ staff_id: user.id, username: user.username, role: user.role });
  setAuthCookie(res, token);
  res.json({ success: true, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
});

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.get('/me', requireStaff, async (req, res) => {
  const { rows } = await pg.query(
    `SELECT id, username, full_name, role FROM staff_users WHERE id = $1`,
    [req.staff.staff_id]
  );
  if (!rows[0]) return res.status(401).json({ success: false, message: 'Akun tidak ditemukan' });
  res.json({ success: true, user: rows[0] });
});

module.exports = router;
```

- [ ] **Step 6.5: Implement `backend/db/seedStaff.js`** (idempotent, ensures `staff_users` exists + seeds first admin)

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('./postgres');
const { hashPassword } = require('../services/password');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        full_name     VARCHAR(100),
        role          VARCHAR(20) DEFAULT 'staff',
        active        BOOLEAN DEFAULT true,
        last_login_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const seedUser = process.env.CRM_SEED_USERNAME || 'finance';
    const seedPass = process.env.CRM_SEED_PASSWORD || 'Bunga123';
    const existing = await client.query(`SELECT id FROM staff_users WHERE username = $1`, [seedUser]);
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO staff_users (username, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'admin')`,
        [seedUser, hashPassword(seedPass), 'Finance Prestisa']
      );
      console.log(`[seedStaff] seeded admin: ${seedUser}`);
    } else {
      console.log(`[seedStaff] admin '${seedUser}' already exists`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
```

- [ ] **Step 6.6: Add npm script for seedStaff**

Edit `backend/package.json` `scripts` block, add:
```json
"seed:staff": "node db/seedStaff.js"
```

- [ ] **Step 6.7: Write integration test `backend/__tests__/auth.test.js`**

```javascript
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const authRoutes = require('../routes/auth');
const { hashPassword } = require('../services/password');

const TEST_USER = `pilot_test_${Date.now()}`;
const TEST_PASS = 'TestPass123!';

let app;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pg.query(
    `INSERT INTO staff_users (username, password_hash, full_name, role) VALUES ($1, $2, 'Pilot Test', 'admin')`,
    [TEST_USER, hashPassword(TEST_PASS)]
  );
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM staff_users WHERE username = $1`, [TEST_USER]);
  await pg.end();
});

test('POST /login rejects empty body', async () => {
  const r = await request(app).post('/api/auth/login').send({});
  expect(r.status).toBe(400);
  expect(r.body.success).toBe(false);
});

test('POST /login rejects bad password', async () => {
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER, password: 'wrong' });
  expect(r.status).toBe(401);
});

test('POST /login succeeds and sets cookie', async () => {
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER, password: TEST_PASS });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.user.username).toBe(TEST_USER);
  expect(r.headers['set-cookie'][0]).toMatch(/crm_pilot_token=/);
});

test('GET /me requires auth', async () => {
  const r = await request(app).get('/api/auth/me');
  expect(r.status).toBe(401);
});

test('GET /me returns user when authed', async () => {
  const login = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER, password: TEST_PASS });
  const cookie = login.headers['set-cookie'];
  const r = await request(app).get('/api/auth/me').set('Cookie', cookie);
  expect(r.status).toBe(200);
  expect(r.body.user.username).toBe(TEST_USER);
});
```

- [ ] **Step 6.8: Run auth test to verify FAIL** (modules missing)

```bash
cd /home/krttpt/crm/backend && npm test -- auth
```

Expected: import errors initially. After all files created in steps 6.1-6.5, the test should pass.

- [ ] **Step 6.9: Run seedStaff once to ensure `staff_users` exists in PG**

```bash
cd /home/krttpt/crm/backend && npm run seed:staff
```

Expected: `[seedStaff] seeded admin: finance` (first time) or `already exists`.

- [ ] **Step 6.10: Run auth test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- auth
```

Expected: all 5 tests pass.

- [ ] **Step 6.11: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/password.js backend/middleware/auth.js backend/middleware/webhookAuth.js \
        backend/routes/auth.js backend/db/seedStaff.js backend/package.json \
        backend/__tests__/auth.test.js
git commit -m "feat(auth): add JWT cookie auth, password hashing, login/logout/me routes"
```

---

## Task 7: Webhook ingestion (POST /webhook/waha → enqueue)

**Files:**
- Create: `/home/krttpt/crm/backend/routes/webhook.js`
- Create: `/home/krttpt/crm/backend/__tests__/webhook.test.js`

- [ ] **Step 7.1: Write failing test `backend/__tests__/webhook.test.js`**

```javascript
process.env.WAHA_WEBHOOK_SECRET = 'test-secret';
process.env.WA_PROVIDER = 'waha';

jest.mock('../services/contactResolver', () => ({
  jidToPhone: jest.fn((jid) => String(jid).split('@')[0]),
  normalizePhone: jest.fn((p) => p),
  resolveByPhone: jest.fn().mockResolvedValue({ customer_id: 7, name: 'Test Cust' }),
}));

const express = require('express');
const request = require('supertest');
const pg = require('../db/postgres');
const webhookRoutes = require('../routes/webhook');

let app;
const TEST_PHONE = `62888${Date.now() % 100000000}`;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/webhook', webhookRoutes);
});

afterAll(async () => {
  // cleanup any rows created with test phone
  await pg.query(
    `DELETE FROM crm_inbound_queue
       WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`,
    [TEST_PHONE]
  );
  await pg.query(`DELETE FROM crm_messages
                  WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`,
                 [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.end();
});

test('rejects without webhook secret', async () => {
  const r = await request(app).post('/webhook/waha').send({ wa_jid: `${TEST_PHONE}@c.us`, body: 'hi' });
  expect(r.status).toBe(401);
});

test('skips group jids', async () => {
  const r = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: '120@g.us', body: 'hi' });
  expect(r.status).toBe(200);
  expect(r.body.skipped).toBe('group');
});

test('inserts message + queue row, returns conversation_id', async () => {
  const r = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, push_name: 'Test', body: 'mau pesan papan',
            waha_message_id: `tmid-${Date.now()}` });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.conversation_id).toBeDefined();

  const conv = await pg.query(`SELECT * FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  expect(conv.rows[0].customer_id).toBe(7);

  const msg = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 AND direction = 'in'`,
    [r.body.conversation_id]
  );
  expect(msg.rows[0].body).toBe('mau pesan papan');

  const q = await pg.query(
    `SELECT * FROM crm_inbound_queue WHERE conversation_id = $1`, [r.body.conversation_id]
  );
  expect(q.rows[0].status).toBe('pending');
});

test('idempotent on duplicate waha_message_id (no second queue row)', async () => {
  const dupId = `dup-${Date.now()}`;
  const r1 = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, body: 'first', waha_message_id: dupId });
  expect(r1.body.success).toBe(true);

  const r2 = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, body: 'first-again', waha_message_id: dupId });
  expect(r2.status).toBe(200);
  expect(r2.body.duplicate).toBe(true);

  const q = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE waha_message_id = $1`, [dupId]
  );
  expect(q.rows[0].n).toBe(1);
});

test('non-text (media) → enqueues for handover decision in worker', async () => {
  const r = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, body: null, media_url: 'https://x/y.jpg',
            media_mimetype: 'image/jpeg', waha_message_id: `media-${Date.now()}` });
  expect(r.body.success).toBe(true);
  const msg = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
    [r.body.conversation_id]
  );
  expect(msg.rows[0].message_type).toBe('media');
  expect(msg.rows[0].attachment_url).toBe('https://x/y.jpg');
});
```

- [ ] **Step 7.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- webhook
```

Expected: module not found.

- [ ] **Step 7.3: Implement `backend/routes/webhook.js`**

```javascript
const express = require('express');
const pg = require('../db/postgres');
const { verifyWebhookSecret } = require('../middleware/webhookAuth');
const { resolveByPhone } = require('../services/contactResolver');
const waClient = require('../services/waClient');

const router = express.Router();

router.post('/waha', verifyWebhookSecret, async (req, res) => {
  const parsed = waClient.parseInbound(req.body || {});

  if (parsed.skip) {
    return res.json({ success: true, skipped: parsed.skip });
  }
  if (!parsed.phone) {
    return res.status(400).json({ success: false, message: 'phone missing in payload' });
  }

  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check
    if (parsed.wahaMessageId) {
      const existing = await client.query(
        `SELECT id, conversation_id FROM crm_messages WHERE waha_message_id = $1`,
        [parsed.wahaMessageId]
      );
      if (existing.rowCount > 0) {
        await client.query('COMMIT');
        return res.json({
          success: true,
          duplicate: true,
          message_id: existing.rows[0].id,
          conversation_id: existing.rows[0].conversation_id,
        });
      }
    }

    const resolved = await resolveByPhone(parsed.phone);

    const convQ = await client.query(
      `INSERT INTO crm_conversations (phone, customer_id, last_message_at)
       VALUES ($1, $2, now())
       ON CONFLICT (phone) DO UPDATE SET
         last_message_at = now(),
         customer_id = COALESCE(crm_conversations.customer_id, EXCLUDED.customer_id),
         updated_at = now()
       RETURNING id, ai_enabled, ai_paused_until, status, shadow_mode`,
      [parsed.phone, resolved.customer_id]
    );
    const conv = convQ.rows[0];

    const msgType = parsed.type === 'media' ? 'media' : 'text';
    const msgQ = await client.query(
      `INSERT INTO crm_messages
         (conversation_id, direction, sender_type, waha_message_id, body, message_type, attachment_url)
       VALUES ($1, 'in', 'customer', $2, $3, $4, $5)
       RETURNING id, created_at`,
      [conv.id, parsed.wahaMessageId, parsed.body, msgType, parsed.mediaUrl]
    );
    const msg = msgQ.rows[0];

    // enqueue (always — worker decides handover for non-text / paused / ai_disabled)
    await client.query(
      `INSERT INTO crm_inbound_queue (message_id, conversation_id) VALUES ($1, $2)`,
      [msg.id, conv.id]
    );

    await client.query('COMMIT');

    // emit to operator UI
    const io = req.app.get('io');
    if (io) {
      io.to(`crm:conv:${conv.id}`).emit('crm:message', {
        conversation_id: conv.id,
        message: {
          id: msg.id,
          direction: 'in',
          sender_type: 'customer',
          body: parsed.body,
          message_type: msgType,
          attachment_url: parsed.mediaUrl,
          created_at: msg.created_at,
        },
      });
      io.to('crm:inbox').emit('crm:conv-updated', { conversation_id: conv.id });
    }

    res.json({
      success: true,
      conversation_id: conv.id,
      message_id: msg.id,
      ai_enabled: conv.ai_enabled,
      paused: !!conv.ai_paused_until,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[webhook/waha]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
```

- [ ] **Step 7.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- webhook
```

Expected: 5 tests pass.

- [ ] **Step 7.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/routes/webhook.js backend/__tests__/webhook.test.js
git commit -m "feat(webhook): add POST /webhook/waha — idempotent ingest into crm_messages and queue"
```

---

## Task 8: AI knowledge base (static FAQ topics)

**Files:**
- Create: `/home/krttpt/crm/backend/services/aiKnowledge.js`
- Create: `/home/krttpt/crm/backend/__tests__/aiKnowledge.test.js`

- [ ] **Step 8.1: Write failing test**

```javascript
const { getFaqTopic, listFaqTopics } = require('../services/aiKnowledge');

test('listFaqTopics returns the curated set', () => {
  const topics = listFaqTopics();
  expect(topics).toEqual(expect.arrayContaining([
    'payment', 'refund_policy', 'cancel_policy', 'hours',
    'lead_time', 'area_coverage', 'shipping_fee', 'product_type',
    'how_to_order', 'invoice', 'about',
  ]));
});

test('getFaqTopic returns text for known topic', () => {
  const text = getFaqTopic('payment');
  expect(typeof text).toBe('string');
  expect(text.length).toBeGreaterThan(20);
  expect(text.toLowerCase()).toMatch(/transfer|va|virtual account|qris/);
});

test('getFaqTopic returns null for unknown topic', () => {
  expect(getFaqTopic('nonsense')).toBeNull();
});
```

- [ ] **Step 8.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiKnowledge
```

- [ ] **Step 8.3: Implement `backend/services/aiKnowledge.js`**

```javascript
// Static FAQ knowledge — short, factual answers Tiara can quote.
// Keep wording neutral; persona prompt will adapt tone.
// Update via PR; future sub-spec will pipeline FAQ refresh from real conversations.

const FAQ = {
  payment: `Pembayaran bisa via transfer bank (BCA / Mandiri / BRI / BNI), QRIS, atau Virtual Account. Setelah transfer, bukti otomatis terverifikasi dalam beberapa menit. Kalau belum kebaca dalam 30 menit, hubungi tim Prestisa.`,

  refund_policy: `Refund bisa diproses kalau order belum mulai diproduksi (sebelum 3-6 jam window pengiriman dimulai) dengan menghubungi tim Prestisa. Setelah masuk produksi, refund tidak bisa dilakukan, tapi bisa diganti tanggal kirim atau revisi alamat (selama belum dikirim).`,

  cancel_policy: `Cancel bisa dilakukan sebelum produksi mulai. Hubungi tim Prestisa secepatnya, sebutkan nomor order. Setelah produksi mulai, cancel tidak bisa dilakukan, tapi penjadwalan ulang masih mungkin.`,

  hours: `Prestisa beroperasi 24/7 untuk pemesanan online. Tim customer service aktif jam 08.00-22.00 WIB setiap hari. Order yang masuk di luar jam ini tetap diproses, tinggal menunggu konfirmasi pembayaran.`,

  lead_time: `Lead time pengiriman 3-6 jam setelah pembayaran terkonfirmasi. Untuk papan bunga di kota besar (Jakarta, Surabaya, Bandung, dll), bisa lebih cepat. Untuk kota kecil atau jam puncak (Valentine, Mother's Day, Hari Raya), bisa lebih lama — tim akan info kalau ada delay.`,

  area_coverage: `Prestisa cover hampir semua kota di Indonesia. Untuk Jabodetabek free ongkir, area lain Rp50.000. Kalau kotanya tidak tercover, sistem akan kasih tahu saat checkout.`,

  shipping_fee: `Free ongkir untuk wilayah Jabodetabek. Area lain Rp50.000 flat. Untuk pulau di luar Jawa atau lokasi remote, tim akan info kalau ada penyesuaian.`,

  product_type: `Prestisa menyediakan: papan bunga (sukacita, dukacita, congratulations, grand opening), bouquet (hand bouquet, standing bouquet), parsel (lebaran, natal, fruit basket), dan cake (ulang tahun, anniversary). Setiap kategori ada banyak desain dan range harga.`,

  how_to_order: `Cara order: kasih tahu jenis (papan/bouquet/parsel/cake), kota tujuan, dan budget. Kami kasih beberapa pilihan desain dengan harga. Setelah pilih, isi form order yang kami kirim — alamat penerima, ucapan kartu, dll. Bayar via VA/transfer/QRIS, dan order langsung diproses.`,

  invoice: `Invoice/faktur otomatis dikirim via email setelah pembayaran terkonfirmasi. Kalau belum sampai, cek folder spam atau hubungi tim untuk dikirim ulang. Untuk faktur pajak/PPN, beritahu sebelum order dikonfirmasi.`,

  about: `Prestisa adalah toko bunga online yang melayani karangan bunga papan, bouquet, parsel, dan cake ke hampir seluruh kota di Indonesia. Berdiri sejak [tahun], kami fokus pada kecepatan pengiriman (3-6 jam) dan kualitas presentasi.`,
};

function listFaqTopics() {
  return Object.keys(FAQ);
}

function getFaqTopic(topic) {
  if (!topic) return null;
  const key = String(topic).toLowerCase().trim();
  return FAQ[key] || null;
}

module.exports = { listFaqTopics, getFaqTopic };
```

- [ ] **Step 8.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- aiKnowledge
```

- [ ] **Step 8.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiKnowledge.js backend/__tests__/aiKnowledge.test.js
git commit -m "feat(ai): add static FAQ knowledge base (11 topics)"
```

---

## Task 9: AI tools — catalog, shipping, promos, FAQ, order-form-url, list-categories

**Files:**
- Create: `/home/krttpt/crm/backend/services/aiTools.js` (initial — tools 1-6)
- Create: `/home/krttpt/crm/backend/__tests__/aiTools.catalog.test.js`

> Note: Tool declarations use **Anthropic input_schema format** (JSON Schema), not Gemini's. Each tool's executor receives `({ args, conv, customer_id, phone })` so phone/customer_id are auto-injected (never LLM-supplied) per spec §6.

- [ ] **Step 9.1: Write failing test for catalog/shipping/promos/FAQ/order-form/list-categories**

```javascript
jest.mock('../db/mysql', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../db/postgres', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
}));

const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const { declarations, executors } = require('../services/aiTools');

const ctx = { conv: { id: 1 }, customer_id: 7, phone: '628111111111' };

beforeEach(() => { mysql.query.mockReset(); pg.query.mockReset(); });

test('declarations include core tools with anthropic input_schema', () => {
  const names = declarations.map((d) => d.name);
  expect(names).toEqual(expect.arrayContaining([
    'search_products', 'list_categories', 'get_shipping_info',
    'get_active_promos', 'get_faq', 'build_order_form_url',
  ]));
  for (const d of declarations) {
    expect(d).toHaveProperty('description');
    expect(d).toHaveProperty('input_schema');
    expect(d.input_schema.type).toBe('object');
  }
});

describe('search_products', () => {
  test('queries MySQL with filters and returns max 5', async () => {
    mysql.query.mockResolvedValueOnce([[
      { id: 1, name: 'Papan A', category: 'Sukacita', price: 500000, city: 'Jakarta', image_url: 'x', description: 'd' },
    ]]);
    const out = await executors.search_products({ args: { category: 'Sukacita', city: 'Jakarta', budget_max: 1000000 }, ...ctx });
    expect(out.count).toBe(1);
    expect(out.products[0].name).toBe('Papan A');
    const [sql, params] = mysql.query.mock.calls[0];
    expect(sql).toMatch(/LIMIT/);
    expect(params).toContain('Jakarta');
  });

  test('returns empty result with helpful note when no rows', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    const out = await executors.search_products({ args: { query: 'unicorn flowers' }, ...ctx });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/tidak ditemukan/i);
  });
});

describe('list_categories', () => {
  test('returns categories grouped by city', async () => {
    mysql.query.mockResolvedValueOnce([[
      { category_id: 1, name: 'Papan Sukacita', count: 12 },
      { category_id: 2, name: 'Bouquet', count: 8 },
    ]]);
    const out = await executors.list_categories({ args: { city: 'Jakarta' }, ...ctx });
    expect(out.categories).toHaveLength(2);
    expect(out.categories[0].name).toBe('Papan Sukacita');
  });
});

describe('get_shipping_info', () => {
  test('Jabodetabek = free', async () => {
    const out = await executors.get_shipping_info({ args: { destination_city: 'Jakarta Selatan' }, ...ctx });
    expect(out.fee).toBe(0);
    expect(out.eta_text).toMatch(/3-6 jam/);
  });
  test('Bandung = paid 50000', async () => {
    const out = await executors.get_shipping_info({ args: { destination_city: 'Bandung' }, ...ctx });
    expect(out.fee).toBe(50000);
  });
  test('returns available=true for known cities', async () => {
    mysql.query.mockResolvedValueOnce([[{ name: 'Surabaya' }]]);
    const out = await executors.get_shipping_info({ args: { destination_city: 'Surabaya' }, ...ctx });
    expect(out.available).toBe(true);
  });
});

describe('get_active_promos', () => {
  test('queries crm_promo_settings with active filter', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ code: 'WELCOME10', description: 'New cust 10%', discount_pct: 10, ends_at: new Date('2026-12-31') }] });
    const out = await executors.get_active_promos({ args: {}, ...ctx });
    expect(out.count).toBe(1);
    expect(out.promos[0].code).toBe('WELCOME10');
  });
  test('empty promo list returns helpful note', async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });
    const out = await executors.get_active_promos({ args: {}, ...ctx });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/belum ada/i);
  });
});

describe('get_faq', () => {
  test('returns text for valid topic', () => {
    const out = executors.get_faq({ args: { topic: 'payment' }, ...ctx });
    expect(out.text).toMatch(/transfer|va|qris/i);
  });
  test('returns error for invalid topic', () => {
    const out = executors.get_faq({ args: { topic: 'xyz' }, ...ctx });
    expect(out.error).toMatch(/topic/i);
  });
});

describe('build_order_form_url', () => {
  beforeAll(() => {
    process.env.ORDER_FORM_PAPAN_URL = 'https://orderpapan.prestisa.net';
    process.env.ORDER_FORM_BUNGA_URL = 'https://orderbunga.prestisa.net';
  });
  test('papan uses ORDER_FORM_PAPAN_URL with prefilled querystring', () => {
    const out = executors.build_order_form_url({
      args: { product_type: 'papan', prefill: { name: 'Andi', city: 'Jakarta' } }, ...ctx,
    });
    expect(out.url).toMatch(/^https:\/\/orderpapan\.prestisa\.net/);
    expect(out.url).toContain('phone=628111111111');
    expect(out.url).toContain('city=Jakarta');
  });
  test('bouquet uses ORDER_FORM_BUNGA_URL', () => {
    const out = executors.build_order_form_url({
      args: { product_type: 'bouquet', prefill: {} }, ...ctx,
    });
    expect(out.url).toMatch(/^https:\/\/orderbunga\.prestisa\.net/);
  });
  test('rejects unknown product_type', () => {
    const out = executors.build_order_form_url({
      args: { product_type: 'rocketship', prefill: {} }, ...ctx,
    });
    expect(out.error).toMatch(/product_type/i);
  });
});
```

- [ ] **Step 9.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiTools.catalog
```

- [ ] **Step 9.3: Implement `backend/services/aiTools.js` (tools 1-6 only — Task 10 adds the rest)**

```javascript
const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const { getFaqTopic, listFaqTopics } = require('./aiKnowledge');

// ── Helpers ──────────────────────────────────────────────────────────────────

const JABODETABEK = new Set([
  'jakarta', 'jakarta pusat', 'jakarta utara', 'jakarta selatan',
  'jakarta barat', 'jakarta timur', 'bogor', 'depok', 'tangerang',
  'tangerang selatan', 'bekasi',
]);

function normCity(s) { return String(s || '').trim().toLowerCase(); }

function clampInt(v, def, max) {
  const n = parseInt(v);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

// ── Declarations (Anthropic tool input_schema) ───────────────────────────────

const declarations = [
  {
    name: 'search_products',
    description: 'Cari produk dari katalog Prestisa. Filter optional: category (nama kategori), city (kota tujuan), budget_min/budget_max (rupiah, integer), query (free-text matching nama produk). Return max 5 produk dengan id, name, category, price, city, image_url, description. WAJIB pakai tool ini sebelum menyebut harga atau menawarkan produk.',
    input_schema: {
      type: 'object',
      properties: {
        category:   { type: 'string', description: 'Nama kategori (mis. "Papan Sukacita", "Bouquet").' },
        city:       { type: 'string', description: 'Kota tujuan kirim.' },
        budget_min: { type: 'integer', description: 'Budget minimum dalam rupiah.' },
        budget_max: { type: 'integer', description: 'Budget maksimum dalam rupiah.' },
        query:      { type: 'string', description: 'Kata kunci nama produk.' },
      },
    },
  },
  {
    name: 'list_categories',
    description: 'Daftar kategori produk yang tersedia di kota tertentu, dengan jumlah produk per kategori. Pakai saat customer tanya "ada produk apa aja di kotaku?".',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Kota tujuan.' },
      },
      required: ['city'],
    },
  },
  {
    name: 'get_shipping_info',
    description: 'Cek apakah kota tujuan tercover dan ongkir berapa. Jabodetabek free, area lain Rp50.000. ETA 3-6 jam setelah pembayaran terkonfirmasi.',
    input_schema: {
      type: 'object',
      properties: {
        destination_city: { type: 'string', description: 'Kota tujuan pengiriman.' },
      },
      required: ['destination_city'],
    },
  },
  {
    name: 'get_active_promos',
    description: 'Cek promo yang sedang aktif. Filter optional category dan city. Return list promo dengan code, description, discount_pct/discount_amount, ends_at. Kalau kosong, jangan janjikan diskon.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        city:     { type: 'string' },
      },
    },
  },
  {
    name: 'get_faq',
    description: `Ambil teks FAQ untuk topik tertentu. Topic enum: ${listFaqTopics().join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: listFaqTopics() },
      },
      required: ['topic'],
    },
  },
  {
    name: 'build_order_form_url',
    description: 'Bangun URL form order prefilled dengan data customer. Pakai ini sebagai langkah closing — link akan dibuka customer untuk verifikasi & bayar.',
    input_schema: {
      type: 'object',
      properties: {
        product_type: { type: 'string', enum: ['papan', 'bouquet', 'parsel', 'cake'] },
        prefill: {
          type: 'object',
          description: 'Data prefilled: name, city, recipient_address, recipient_name, card_message, sender_name, recipient_wa.',
          properties: {
            name:              { type: 'string' },
            city:              { type: 'string' },
            recipient_address: { type: 'string' },
            recipient_name:    { type: 'string' },
            card_message:      { type: 'string' },
            sender_name:       { type: 'string' },
            recipient_wa:      { type: 'string' },
          },
        },
      },
      required: ['product_type'],
    },
  },
];

// ── Executors ────────────────────────────────────────────────────────────────

async function search_products({ args }) {
  const limit = 5;
  const where = ['p.deleted_at IS NULL'];
  const params = [];

  if (args.category) {
    params.push(args.category);
    where.push(`(c.name = ? OR p.category_name LIKE CONCAT('%', ?, '%'))`);
    params.push(args.category);
  }
  if (args.city) {
    params.push(args.city);
    where.push(`(p.city = ? OR p.city IS NULL)`);
  }
  if (args.budget_min) {
    params.push(parseInt(args.budget_min));
    where.push(`p.price >= ?`);
  }
  if (args.budget_max) {
    params.push(parseInt(args.budget_max));
    where.push(`p.price <= ?`);
  }
  if (args.query) {
    params.push(`%${args.query}%`);
    where.push(`p.name LIKE ?`);
  }

  const sql = `
    SELECT p.id, p.name, COALESCE(c.name, p.category_name) AS category,
           p.price, p.city, p.image_url, p.description
    FROM products p
    LEFT JOIN product_category_new c ON c.id = p.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.id DESC
    LIMIT ${limit}`;
  const [rows] = await mysql.query(sql, params);
  if (!rows.length) {
    return { count: 0, products: [], note: 'Tidak ditemukan produk yang cocok dengan filter ini.' };
  }
  return { count: rows.length, products: rows };
}

async function list_categories({ args }) {
  const city = String(args.city || '').trim();
  if (!city) return { error: 'city wajib diisi' };
  const [rows] = await mysql.query(
    `SELECT c.id AS category_id, c.name, COUNT(p.id) AS count
     FROM product_category_new c
     LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
       AND (p.city = ? OR p.city IS NULL)
     GROUP BY c.id, c.name
     HAVING count > 0
     ORDER BY count DESC
     LIMIT 30`,
    [city]
  );
  return { city, count: rows.length, categories: rows };
}

async function get_shipping_info({ args }) {
  const city = String(args.destination_city || '').trim();
  if (!city) return { error: 'destination_city wajib diisi' };
  const isJabodetabek = JABODETABEK.has(normCity(city));
  let available = true;
  try {
    const [rows] = await mysql.query(
      `SELECT name FROM city WHERE LOWER(name) = ? LIMIT 1`,
      [normCity(city)]
    );
    available = rows.length > 0 || isJabodetabek;
  } catch {
    available = isJabodetabek;
  }
  return {
    available,
    fee: isJabodetabek ? 0 : 50000,
    eta_text: '3-6 jam setelah pembayaran terkonfirmasi',
    note: isJabodetabek ? 'Free ongkir Jabodetabek' : 'Ongkir flat Rp50.000 untuk luar Jabodetabek',
  };
}

async function get_active_promos({ args }) {
  const params = [];
  const where = ['active = TRUE', 'starts_at <= now()', 'ends_at > now()'];
  if (args.category) { params.push(args.category); where.push(`(product_category IS NULL OR product_category = $${params.length})`); }
  if (args.city) { params.push(args.city); where.push(`(city IS NULL OR city = $${params.length})`); }
  const { rows } = await pg.query(
    `SELECT code, description, discount_pct, discount_amount, ends_at
     FROM crm_promo_settings
     WHERE ${where.join(' AND ')}
     ORDER BY ends_at ASC
     LIMIT 10`,
    params
  );
  if (!rows.length) {
    return {
      count: 0,
      promos: [],
      note: 'Belum ada promo aktif. Sampaikan apa adanya, jangan janjikan diskon.',
    };
  }
  return { count: rows.length, promos: rows };
}

function get_faq({ args }) {
  const topic = String(args.topic || '').toLowerCase();
  const text = getFaqTopic(topic);
  if (!text) return { error: `topic "${topic}" tidak dikenal. Valid: ${listFaqTopics().join(', ')}` };
  return { topic, text };
}

function build_order_form_url({ args, phone }) {
  const type = String(args.product_type || '').toLowerCase();
  let base;
  if (type === 'papan') base = process.env.ORDER_FORM_PAPAN_URL;
  else if (['bouquet', 'parsel', 'cake'].includes(type)) base = process.env.ORDER_FORM_BUNGA_URL;
  else return { error: `product_type "${type}" tidak dikenal. Valid: papan, bouquet, parsel, cake.` };

  if (!base) return { error: 'ORDER_FORM_*_URL belum dikonfigurasi di .env' };

  const prefill = args.prefill || {};
  const params = new URLSearchParams();
  params.set('phone', phone || '');
  if (prefill.name)              params.set('name', prefill.name);
  if (prefill.city)              params.set('city', prefill.city);
  if (prefill.recipient_address) params.set('recipient_address', prefill.recipient_address);
  if (prefill.recipient_name)    params.set('recipient_name', prefill.recipient_name);
  if (prefill.card_message)      params.set('card_message', prefill.card_message);
  if (prefill.sender_name)       params.set('sender_name', prefill.sender_name);
  if (prefill.recipient_wa)      params.set('recipient_wa', prefill.recipient_wa);

  return { url: `${base}?${params.toString()}` };
}

const executors = {
  search_products,
  list_categories,
  get_shipping_info,
  get_active_promos,
  get_faq,
  build_order_form_url,
};

module.exports = { declarations, executors };
```

- [ ] **Step 9.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- aiTools.catalog
```

- [ ] **Step 9.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiTools.js backend/__tests__/aiTools.catalog.test.js
git commit -m "feat(ai-tools): add 6 catalog/shipping/promo/FAQ/order-form tools"
```

---

## Task 10: AI tools — orders + handover

**Files:**
- Modify: `/home/krttpt/crm/backend/services/aiTools.js` (append 3 tools)
- Create: `/home/krttpt/crm/backend/__tests__/aiTools.orders.test.js`

- [ ] **Step 10.1: Write failing test for find_customer_orders / get_order_status / request_handover**

```javascript
jest.mock('../db/mysql', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../db/postgres', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));

const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const { executors } = require('../services/aiTools');

const ctx = { conv: { id: 99 }, customer_id: 7, phone: '628111111111' };

beforeEach(() => { mysql.query.mockReset(); pg.query.mockReset(); });

describe('find_customer_orders', () => {
  test('returns recent orders scoped to customer_id', async () => {
    mysql.query.mockResolvedValueOnce([[
      { order_id: 100, order_number: 'ORD-100', total: 750000, status: 'approved', created_at: new Date() },
    ]]);
    const out = await executors.find_customer_orders({ args: { limit: 5 }, ...ctx });
    expect(out.count).toBe(1);
    expect(out.orders[0].order_id).toBe(100);
    const [, params] = mysql.query.mock.calls[0];
    expect(params).toContain(7); // customer_id auto-injected
  });

  test('handles no customer linked', async () => {
    const out = await executors.find_customer_orders({ args: {}, conv: { id: 1 }, customer_id: null, phone: '628' });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/belum terhubung/i);
    expect(mysql.query).not.toHaveBeenCalled();
  });

  test('clamps limit to max 20', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    await executors.find_customer_orders({ args: { limit: 999 }, ...ctx });
    const [sql] = mysql.query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 20/);
  });
});

describe('get_order_status', () => {
  test('returns order with items and PO status', async () => {
    mysql.query
      .mockResolvedValueOnce([[{ id: 100, order_number: 'ORD-100', status: 'approved', total: 750000, created_at: new Date() }]])
      .mockResolvedValueOnce([[
        { id: 1, product_name: 'Papan A', qty: 1, price: 750000, status: 'producing', purchase_order_status: 'in_progress' },
      ]]);
    const out = await executors.get_order_status({ args: { order_id: 100 }, ...ctx });
    expect(out.order_number).toBe('ORD-100');
    expect(out.items).toHaveLength(1);
  });

  test('rejects access to order from another customer', async () => {
    mysql.query.mockResolvedValueOnce([[]]); // empty = not found OR not theirs
    const out = await executors.get_order_status({ args: { order_id: 100 }, ...ctx });
    expect(out.error).toMatch(/tidak ditemukan/i);
  });
});

describe('request_handover', () => {
  test('inserts crm_handovers row, pauses AI, returns ok', async () => {
    pg.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 555 }] }) // INSERT crm_handovers
      .mockResolvedValueOnce({ rowCount: 1 });                     // UPDATE crm_conversations
    const out = await executors.request_handover({
      args: { reason: 'complaint', summary: 'customer complains about late delivery' }, ...ctx,
    });
    expect(out.ok).toBe(true);
    expect(out.handover_id).toBe(555);
    expect(pg.query).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid reason', async () => {
    const out = await executors.request_handover({ args: { reason: 'lol', summary: 'x' }, ...ctx });
    expect(out.error).toMatch(/reason/);
  });
});
```

- [ ] **Step 10.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiTools.orders
```

- [ ] **Step 10.3: Append 3 tools to `backend/services/aiTools.js`**

Open `backend/services/aiTools.js` and:

(a) Add to the `declarations` array (before the closing `]`):

```javascript
  {
    name: 'find_customer_orders',
    description: 'Daftar order terbaru milik customer ini. Customer_id auto-scoped, JANGAN minta dari user. Return max 20.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Jumlah max (default 5, max 20).' },
      },
    },
  },
  {
    name: 'get_order_status',
    description: 'Detail status 1 order (header, items dengan PO status, ETA). Pakai setelah find_customer_orders memberi order_id. Customer_id auto-scoped.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'ID internal order.' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'request_handover',
    description: 'Eskalasi ke operator manusia. Pakai untuk: complaint, refund, cancel, pricing-custom, low-confidence, atau saat customer minta orang. Setelah ini AI pause 24 jam di percakapan ini.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['complaint', 'refund', 'cancel', 'custom_price', 'explicit_request_human', 'low_confidence', 'tool_error', 'other'] },
        summary: { type: 'string', description: 'Ringkasan singkat untuk operator (1-2 kalimat).' },
      },
      required: ['reason', 'summary'],
    },
  },
```

(b) Add executors above the `const executors = {...}` block:

```javascript
const VALID_HANDOVER_REASONS = new Set([
  'complaint', 'refund', 'cancel', 'custom_price',
  'explicit_request_human', 'low_confidence', 'tool_error', 'other',
]);

async function find_customer_orders({ args, customer_id }) {
  if (!customer_id) {
    return { count: 0, orders: [], note: 'Customer ini belum terhubung ke akun Prestisa. Tanya nomor order langsung atau handover.' };
  }
  const limit = clampInt(args.limit, 5, 20);
  const sql = `
    SELECT id AS order_id, order_number, total, status, created_at
    FROM \`order\`
    WHERE customer_id = ? AND deleted_at IS NULL
    ORDER BY id DESC
    LIMIT ${limit}`;
  const [rows] = await mysql.query(sql, [customer_id]);
  return { count: rows.length, orders: rows };
}

async function get_order_status({ args, customer_id }) {
  const orderId = parseInt(args.order_id);
  if (!orderId) return { error: 'order_id wajib diisi' };
  if (!customer_id) return { error: 'Customer ini belum terhubung ke akun Prestisa.' };

  const [orders] = await mysql.query(
    `SELECT id, order_number, status, total, created_at
     FROM \`order\`
     WHERE id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
    [orderId, customer_id]
  );
  if (!orders.length) return { error: `order_id ${orderId} tidak ditemukan untuk customer ini` };
  const order = orders[0];

  const [items] = await mysql.query(
    `SELECT oi.id, oi.product_name, oi.qty, oi.price, oi.status,
            po.status AS purchase_order_status
     FROM order_items oi
     LEFT JOIN purchase_order po ON po.id = oi.purchase_order_id
     WHERE oi.order_id = ? AND oi.deleted_at IS NULL
     LIMIT 30`,
    [orderId]
  );
  return {
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    total: order.total,
    created_at: order.created_at,
    items,
    eta_text: '3-6 jam setelah pembayaran terkonfirmasi (untuk item yang belum dikirim)',
  };
}

async function request_handover({ args, conv }) {
  const reason = String(args.reason || '').toLowerCase();
  if (!VALID_HANDOVER_REASONS.has(reason)) {
    return { error: `reason "${reason}" tidak valid. Valid: ${Array.from(VALID_HANDOVER_REASONS).join(', ')}` };
  }
  const summary = String(args.summary || '').slice(0, 1000);

  const ins = await pg.query(
    `INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, $2, $3) RETURNING id`,
    [conv.id, reason, summary]
  );
  await pg.query(
    `UPDATE crm_conversations
       SET ai_paused_until = now() + INTERVAL '24 hours',
           handover_count = handover_count + 1,
           updated_at = now()
     WHERE id = $1`,
    [conv.id]
  );
  return { ok: true, handover_id: ins.rows[0].id, paused_for_hours: 24 };
}
```

(c) Add the new keys to the `executors` map:

```javascript
const executors = {
  search_products,
  list_categories,
  get_shipping_info,
  get_active_promos,
  get_faq,
  build_order_form_url,
  find_customer_orders,
  get_order_status,
  request_handover,
};
```

- [ ] **Step 10.4: Run test to verify PASS (both old and new tool tests)**

```bash
cd /home/krttpt/crm/backend && npm test -- aiTools
```

Expected: all aiTools tests pass.

- [ ] **Step 10.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiTools.js backend/__tests__/aiTools.orders.test.js
git commit -m "feat(ai-tools): add find_customer_orders, get_order_status, request_handover"
```

---

## Task 11: Claude client (Anthropic SDK + tool-call loop + retry)

**Files:**
- Create: `/home/krttpt/crm/backend/services/claudeClient.js`
- Create: `/home/krttpt/crm/backend/__tests__/claudeClient.test.js`

- [ ] **Step 11.1: Write failing test**

```javascript
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

const { generateWithTools } = require('../services/claudeClient');

beforeEach(() => { mockCreate.mockReset(); });

test('returns text when model emits no tool calls', async () => {
  mockCreate.mockResolvedValueOnce({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'halo Kak' }],
    usage: { input_tokens: 100, output_tokens: 5 },
  });
  const out = await generateWithTools({
    systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }],
    tools: [], executor: () => ({}),
  });
  expect(out.text).toBe('halo Kak');
  expect(out.calls).toEqual([]);
  expect(out.usage.input_tokens).toBe(100);
});

test('runs tool then final text', async () => {
  mockCreate
    .mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'cek dulu ya' },
        { type: 'tool_use', id: 'tool_1', name: 'search_products', input: { query: 'mawar' } },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    })
    .mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ada 2 pilihan...' }],
      usage: { input_tokens: 250, output_tokens: 50 },
    });

  const executor = jest.fn().mockResolvedValue({ count: 2, products: [{ id: 1 }] });
  const out = await generateWithTools({
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'cari mawar' }],
    tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object', properties: {} } }],
    executor,
  });

  expect(executor).toHaveBeenCalledWith('search_products', { query: 'mawar' });
  expect(out.text).toBe('ada 2 pilihan...');
  expect(out.calls).toHaveLength(1);
  expect(out.calls[0].name).toBe('search_products');
  expect(out.usage.input_tokens).toBe(450); // accumulated
  expect(out.usage.output_tokens).toBe(80);
});

test('caps at maxIterations', async () => {
  mockCreate.mockResolvedValue({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't', name: 'search_products', input: {} }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const executor = jest.fn().mockResolvedValue({ count: 0 });
  const out = await generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object', properties: {} } }],
    executor, maxIterations: 3,
  });
  expect(out.iterationsCapped).toBe(true);
  expect(out.calls).toHaveLength(3);
});

test('retries on 429 then succeeds', async () => {
  const err429 = new Error('rate limited'); err429.status = 429;
  mockCreate
    .mockRejectedValueOnce(err429)
    .mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  const out = await generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [], executor: () => ({}),
  });
  expect(out.text).toBe('ok');
  expect(mockCreate).toHaveBeenCalledTimes(2);
}, 10000);

test('throws after max retries on persistent 5xx', async () => {
  const err500 = new Error('server'); err500.status = 503;
  mockCreate.mockRejectedValue(err500);
  await expect(generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [], executor: () => ({}),
  })).rejects.toThrow();
}, 15000);

test('tool executor error captured per call (does not abort loop)', async () => {
  mockCreate
    .mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'search_products', input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    .mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'maaf gangguan' }],
      usage: { input_tokens: 20, output_tokens: 10 },
    });
  const executor = jest.fn().mockRejectedValue(new Error('boom'));
  const out = await generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object', properties: {} } }],
    executor,
  });
  expect(out.calls[0].error).toBe('boom');
  expect(out.text).toBe('maaf gangguan');
});
```

- [ ] **Step 11.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- claudeClient
```

- [ ] **Step 11.3: Implement `backend/services/claudeClient.js`**

```javascript
const Anthropic = require('@anthropic-ai/sdk');

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY belum diset');
  client = new Anthropic({ apiKey });
  return client;
}

const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = () => parseInt(process.env.CLAUDE_MAX_TOKENS) || 1024;

async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      if (!RETRYABLE.has(status) || attempt === maxAttempts) break;
      const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Tool-call loop using Anthropic Messages API.
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role: 'user'|'assistant', content: any}>} opts.messages — initial conversation
 * @param {Array} opts.tools — Anthropic-format declarations: { name, description, input_schema }
 * @param {(name: string, args: object) => Promise<object>} opts.executor
 * @param {number} [opts.maxIterations]
 * @returns {Promise<{text: string, calls: Array, usage: {input_tokens, output_tokens}, iterationsCapped: boolean}>}
 */
async function generateWithTools({ systemPrompt, messages, tools, executor, maxIterations = 5 }) {
  const ant = getClient();
  const conversation = [...messages];
  const calls = [];
  let usageIn = 0, usageOut = 0;
  let iterationsCapped = false;

  for (let i = 0; i < maxIterations + 1; i++) {
    const resp = await withRetry(() => ant.messages.create({
      model: MODEL(),
      max_tokens: MAX_TOKENS(),
      system: systemPrompt,
      tools: tools.length ? tools : undefined,
      messages: conversation,
    }));

    usageIn += resp.usage?.input_tokens || 0;
    usageOut += resp.usage?.output_tokens || 0;

    // collect text
    const textBlocks = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    const text = textBlocks.join('').trim();

    // collect tool calls
    const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text, calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped };
    }

    if (i === maxIterations) {
      iterationsCapped = true;
      return { text: text || '', calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped };
    }

    // append assistant turn (whole response content) to conversation
    conversation.push({ role: 'assistant', content: resp.content });

    // execute each tool, collect results
    const toolResults = [];
    for (const tu of toolUses) {
      const callRecord = { id: tu.id, name: tu.name, args: tu.input || {} };
      try {
        const result = await executor(tu.name, tu.input || {});
        callRecord.result = result;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result ?? null),
        });
      } catch (err) {
        callRecord.error = err?.message || 'tool execution failed';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: callRecord.error,
        });
      }
      calls.push(callRecord);
    }

    conversation.push({ role: 'user', content: toolResults });
  }

  return { text: '', calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped: true };
}

module.exports = { generateWithTools, getClient };
```

- [ ] **Step 11.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- claudeClient
```

Expected: all 6 tests pass (including 2 retry tests that take a few seconds).

- [ ] **Step 11.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/claudeClient.js backend/__tests__/claudeClient.test.js
git commit -m "feat(ai): add Claude client with tool-call loop and retry"
```

---

## Task 12: Gemini classifier client

**Files:**
- Create: `/home/krttpt/crm/backend/services/geminiClient.js`
- Create: `/home/krttpt/crm/backend/__tests__/geminiClient.test.js`

- [ ] **Step 12.1: Write failing test**

```javascript
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

const { classifyIntent } = require('../services/geminiClient');

beforeEach(() => { mockGenerateContent.mockReset(); });

test('returns parsed JSON intent', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => '```json\n{"intent":"complaint","confidence":0.92}\n```' },
  });
  const out = await classifyIntent('mau komplain pesanan saya rusak');
  expect(out.intent).toBe('complaint');
  expect(out.confidence).toBe(0.92);
});

test('handles bare JSON without code fence', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => '{"intent":"order_intent","confidence":0.8}' },
  });
  const out = await classifyIntent('mau pesan papan');
  expect(out.intent).toBe('order_intent');
});

test('falls back to "other" when output is unparseable', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => 'I think this is sad' },
  });
  const out = await classifyIntent('hi');
  expect(out.intent).toBe('other');
  expect(out.confidence).toBe(0);
  expect(out.parseError).toBeDefined();
});

test('returns degraded fallback when API fails', async () => {
  mockGenerateContent.mockRejectedValueOnce(new Error('boom'));
  const out = await classifyIntent('hi');
  expect(out.intent).toBe('unknown');
  expect(out.degraded).toBe(true);
});
```

- [ ] **Step 12.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- geminiClient
```

- [ ] **Step 12.3: Implement `backend/services/geminiClient.js`**

```javascript
const { GoogleGenerativeAI } = require('@google/generative-ai');

const VALID_INTENTS = [
  'complaint', 'refund', 'cancel', 'angry',
  'legal', 'explicit_request_human', 'order_intent',
  'order_status', 'pricing', 'shipping', 'payment', 'faq', 'other',
];

const DANGEROUS_INTENTS = new Set([
  'complaint', 'refund', 'cancel', 'angry', 'legal', 'explicit_request_human',
]);

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY belum diset');
  client = new GoogleGenerativeAI(key);
  return client;
}

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const SYSTEM_PROMPT = `Kamu adalah classifier untuk pesan WhatsApp customer toko bunga online.
Klasifikasikan intent pesan ke salah satu dari:
${VALID_INTENTS.join(', ')}

Definisi:
- complaint: customer mengeluh, kecewa, marah tentang produk/layanan
- refund: minta pengembalian dana
- cancel: minta pembatalan order
- angry: nada marah/agresif tanpa konteks spesifik
- legal: ancaman hukum, viral, lapor polisi, BPSK
- explicit_request_human: minta bicara dengan orang/admin/CS manusia ("ngomong sama orang", "panggilin admin")
- order_intent: ingin pesan/order produk
- order_status: tanya status pesanan existing
- pricing: tanya harga
- shipping: tanya ongkir/pengiriman
- payment: pertanyaan pembayaran (VA, transfer, bukti)
- faq: pertanyaan umum (jam buka, cara order, area cover)
- other: tidak masuk di atas

Output HANYA JSON valid: {"intent": "...", "confidence": 0.0-1.0}
Jangan kasih penjelasan apa-apa di luar JSON.`;

function parseJsonish(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  try { return JSON.parse(raw.trim()); } catch {}
  // try to extract first {...} block
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

async function classifyIntent(messageText) {
  let model;
  try {
    model = getClient().getGenerativeModel({
      model: MODEL(),
      systemInstruction: SYSTEM_PROMPT,
    });
  } catch (err) {
    return { intent: 'unknown', confidence: 0, degraded: true, error: err.message };
  }

  let raw;
  try {
    const res = await model.generateContent(String(messageText || '').slice(0, 2000));
    raw = res.response.text();
  } catch (err) {
    return { intent: 'unknown', confidence: 0, degraded: true, error: err?.message };
  }

  const parsed = parseJsonish(raw);
  if (!parsed || !parsed.intent || !VALID_INTENTS.includes(parsed.intent)) {
    return { intent: 'other', confidence: 0, parseError: 'unparseable_or_unknown', raw: String(raw).slice(0, 200) };
  }
  return {
    intent: parsed.intent,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  };
}

function isDangerous(intent) { return DANGEROUS_INTENTS.has(intent); }

module.exports = { classifyIntent, isDangerous, VALID_INTENTS, DANGEROUS_INTENTS };
```

- [ ] **Step 12.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- geminiClient
```

- [ ] **Step 12.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/geminiClient.js backend/__tests__/geminiClient.test.js
git commit -m "feat(ai): add Gemini intent classifier with dangerous-intent flag"
```

---

## Task 13: AI persona + dynamic context builder

**Files:**
- Create: `/home/krttpt/crm/backend/services/aiPersona.js`
- Create: `/home/krttpt/crm/backend/__tests__/aiPersona.test.js`

- [ ] **Step 13.1: Write failing test**

```javascript
jest.mock('../db/postgres', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../db/mysql', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const { loadActivePrompt, buildSystemPrompt, buildHistoryMessages } = require('../services/aiPersona');

beforeEach(() => { pg.query.mockReset(); mysql.query.mockReset(); });

test('loadActivePrompt returns text from active row', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ name: 'tiara_v1', prompt_text: 'Kamu adalah TIARA...' }] });
  const out = await loadActivePrompt();
  expect(out.name).toBe('tiara_v1');
  expect(out.prompt_text).toMatch(/TIARA/);
});

test('loadActivePrompt throws if none active', async () => {
  pg.query.mockResolvedValueOnce({ rows: [] });
  await expect(loadActivePrompt()).rejects.toThrow(/no active persona/);
});

test('buildSystemPrompt appends dynamic context block', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ name: 'tiara_v1', prompt_text: 'BASE PROMPT' }] });
  mysql.query.mockResolvedValueOnce([[
    { id: 100, order_number: 'ORD-100', total: 500000, status: 'approved', created_at: new Date('2026-04-01') },
  ]]);
  const out = await buildSystemPrompt({
    conv: { id: 1, phone: '628111', customer_id: 7, last_intent: 'pricing' },
    customerName: 'Andi',
    cityHint: 'Jakarta',
  });
  expect(out).toMatch(/BASE PROMPT/);
  expect(out).toMatch(/Andi/);
  expect(out).toMatch(/Jakarta/);
  expect(out).toMatch(/ORD-100/);
});

test('buildSystemPrompt works for unknown customer (no orders)', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ name: 'tiara_v1', prompt_text: 'BASE' }] });
  const out = await buildSystemPrompt({
    conv: { id: 1, phone: '628999', customer_id: null },
    customerName: null,
    cityHint: null,
  });
  expect(out).toMatch(/BASE/);
  expect(out).toMatch(/customer baru/i);
  expect(mysql.query).not.toHaveBeenCalled();
});

test('buildHistoryMessages converts crm_messages rows to anthropic format', () => {
  const rows = [
    { direction: 'in',  sender_type: 'customer', body: 'halo' },
    { direction: 'out', sender_type: 'ai',       body: 'halo Kak' },
    { direction: 'out', sender_type: 'staff',    body: '(operator) ya' },
    { direction: 'in',  sender_type: 'customer', body: 'mau pesan' },
  ];
  const msgs = buildHistoryMessages(rows);
  expect(msgs).toHaveLength(4);
  expect(msgs[0]).toEqual({ role: 'user', content: 'halo' });
  expect(msgs[1]).toEqual({ role: 'assistant', content: 'halo Kak' });
  expect(msgs[2]).toEqual({ role: 'assistant', content: '[operator] (operator) ya' });
  expect(msgs[3]).toEqual({ role: 'user', content: 'mau pesan' });
});

test('buildHistoryMessages skips empty bodies', () => {
  const rows = [
    { direction: 'in', sender_type: 'customer', body: null },
    { direction: 'in', sender_type: 'customer', body: '' },
    { direction: 'in', sender_type: 'customer', body: 'real' },
  ];
  const msgs = buildHistoryMessages(rows);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].content).toBe('real');
});
```

- [ ] **Step 13.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiPersona
```

- [ ] **Step 13.3: Implement `backend/services/aiPersona.js`**

```javascript
const pg = require('../db/postgres');
const mysql = require('../db/mysql');

async function loadActivePrompt() {
  const { rows } = await pg.query(
    `SELECT name, prompt_text FROM crm_persona_prompts WHERE active = TRUE LIMIT 1`
  );
  if (!rows[0]) throw new Error('no active persona prompt — seed migration may not have run');
  return rows[0];
}

async function fetchRecentOrders(customer_id, limit = 3) {
  if (!customer_id) return [];
  try {
    const [rows] = await mysql.query(
      `SELECT id AS order_id, order_number, total, status, created_at
       FROM \`order\`
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY id DESC LIMIT ?`,
      [customer_id, limit]
    );
    return rows;
  } catch (err) {
    console.error('[aiPersona] fetchRecentOrders failed:', err.message);
    return [];
  }
}

function summarizeOrders(orders) {
  if (!orders.length) return 'Tidak ada order historis.';
  return orders.map((o) => {
    const date = o.created_at ? new Date(o.created_at).toISOString().slice(0, 10) : '?';
    return `- ${o.order_number || o.order_id} | Rp${o.total ?? '?'} | ${o.status ?? '?'} | ${date}`;
  }).join('\n');
}

async function buildSystemPrompt({ conv, customerName, cityHint }) {
  const active = await loadActivePrompt();
  const orders = await fetchRecentOrders(conv.customer_id, 3);

  const customerLine = conv.customer_id
    ? `- Customer ID: ${conv.customer_id}, Nama: ${customerName || '(tidak diketahui)'}`
    : '- Customer baru / belum terhubung ke akun Prestisa';

  const cityLine = cityHint ? `- Kota terdeteksi (dari order historis): ${cityHint}` : '';
  const intentLine = conv.last_intent ? `- Intent terakhir: ${conv.last_intent}` : '';

  const dynamic = `
=== KONTEKS DINAMIS (jangan tampilkan ke customer) ===
- Phone: ${conv.phone}
${customerLine}
${cityLine}
${intentLine}
- 3 order terakhir:
${summarizeOrders(orders)}
=== END KONTEKS ===`.trim();

  return `${active.prompt_text}\n\n${dynamic}`;
}

function buildHistoryMessages(rows) {
  const out = [];
  for (const r of rows) {
    const body = (r.body || '').toString().trim();
    if (!body) continue;
    if (r.direction === 'in') {
      out.push({ role: 'user', content: body });
    } else {
      const prefix = r.sender_type === 'staff' ? '[operator] ' : '';
      out.push({ role: 'assistant', content: `${prefix}${body}` });
    }
  }
  return out;
}

module.exports = { loadActivePrompt, buildSystemPrompt, buildHistoryMessages };
```

- [ ] **Step 13.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- aiPersona
```

- [ ] **Step 13.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiPersona.js backend/__tests__/aiPersona.test.js
git commit -m "feat(ai): add persona loader and dynamic context system-prompt builder"
```

---

## Task 14: AI guardrails (post-checker)

**Files:**
- Create: `/home/krttpt/crm/backend/services/aiGuardrails.js`
- Create: `/home/krttpt/crm/backend/__tests__/aiGuardrails.test.js`

> Pre-classifier guardrail (intent dangerous → handover before LLM) is implemented in `geminiClient.isDangerous` (Task 12) and consumed by the worker (Task 17). This task = post-checker for LLM output.

- [ ] **Step 14.1: Write failing test**

```javascript
const { checkReply, extractPriceMentions, hasHesitation, hasSpecificEta } = require('../services/aiGuardrails');

describe('extractPriceMentions', () => {
  test('extracts simple Rp formats', () => {
    expect(extractPriceMentions('Harga Rp 750.000 ya Kak')).toEqual(['750000']);
    expect(extractPriceMentions('Mulai dari 500.000 sampai 1.500.000')).toEqual(['500000', '1500000']);
  });
  test('ignores small numbers (<10000)', () => {
    expect(extractPriceMentions('Pengiriman 3-6 jam, ada 5 stok')).toEqual([]);
  });
  test('handles k/rb suffix', () => {
    expect(extractPriceMentions('mulai 500k aja')).toEqual(['500000']);
  });
});

describe('hasHesitation', () => {
  test('detects common hedging phrases', () => {
    expect(hasHesitation('aku kurang yakin Kak')).toBe(true);
    expect(hasHesitation('Saya tidak tahu')).toBe(true);
    expect(hasHesitation('mungkin sekitar 500rb')).toBe(true);
    expect(hasHesitation('kayaknya iya')).toBe(true);
  });
  test('clean reply returns false', () => {
    expect(hasHesitation('Pilihan papan sukacita harga 750.000 ya Kak')).toBe(false);
  });
});

describe('hasSpecificEta', () => {
  test('flags specific time mentions', () => {
    expect(hasSpecificEta('sampai jam 3 sore')).toBe(true);
    expect(hasSpecificEta('besok pagi sampai')).toBe(true);
    expect(hasSpecificEta('hari ini juga')).toBe(true);
  });
  test('does not flag the canonical "3-6 jam" template', () => {
    expect(hasSpecificEta('pengiriman 3-6 jam setelah pembayaran')).toBe(false);
  });
});

describe('checkReply', () => {
  test('passes a clean reply with prices from tools', () => {
    const out = checkReply({
      reply: 'Pilihan papan sukacita 750.000 ya Kak',
      toolCalls: [{ name: 'search_products', result: { products: [{ price: 750000 }] } }],
    });
    expect(out.passed).toBe(true);
  });

  test('fails on hesitation', () => {
    const out = checkReply({ reply: 'aku kurang yakin', toolCalls: [] });
    expect(out.passed).toBe(false);
    expect(out.reason).toBe('hesitation');
  });

  test('fails on price not from tools', () => {
    const out = checkReply({
      reply: 'Harganya 999.000',
      toolCalls: [{ name: 'search_products', result: { products: [{ price: 500000 }] } }],
    });
    expect(out.passed).toBe(false);
    expect(out.reason).toBe('price_not_in_tool_results');
  });

  test('fails on specific ETA', () => {
    const out = checkReply({
      reply: 'sampai jam 3 sore',
      toolCalls: [],
    });
    expect(out.passed).toBe(false);
    expect(out.reason).toBe('specific_eta');
  });

  test('passes when reply mentions price that matches a promo discount_amount', () => {
    const out = checkReply({
      reply: 'Pakai promo WELCOME10 potongan 50.000',
      toolCalls: [{ name: 'get_active_promos', result: { promos: [{ code: 'WELCOME10', discount_amount: 50000 }] } }],
    });
    expect(out.passed).toBe(true);
  });
});
```

- [ ] **Step 14.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiGuardrails
```

- [ ] **Step 14.3: Implement `backend/services/aiGuardrails.js`**

```javascript
const HESITATION_PATTERNS = [
  /kurang yakin/i,
  /tidak (yakin|tahu|pasti)/i,
  /\bgak (yakin|tau|tahu)\b/i,
  /\bnggak (yakin|tau|tahu)\b/i,
  /\bmungkin\b/i,
  /\bkayaknya\b/i,
  /\bsepertinya\b/i,
  /\bbisa jadi\b/i,
  /maaf saya tidak/i,
];

const SPECIFIC_ETA_PATTERNS = [
  /\bjam\s+\d{1,2}(:\d{2})?\s*(pagi|siang|sore|malam|wib)?/i,
  /\bbesok (pagi|siang|sore|malam)/i,
  /\bhari ini juga\b/i,
  /\bdalam\s+\d+\s*(menit|jam)\b/i,
];

const ETA_TEMPLATE_OK = /3\s*[-–]\s*6\s*jam/i;

function hasHesitation(reply) {
  if (!reply) return false;
  return HESITATION_PATTERNS.some((re) => re.test(reply));
}

function hasSpecificEta(reply) {
  if (!reply) return false;
  if (ETA_TEMPLATE_OK.test(reply)) return false;
  return SPECIFIC_ETA_PATTERNS.some((re) => re.test(reply));
}

// Extract numbers that look like prices (>=10000 or with k/rb suffix)
function extractPriceMentions(reply) {
  if (!reply) return [];
  const out = new Set();

  // pattern 1: 500k / 500rb (case-insensitive)
  const reK = /\b(\d{1,4})\s*(k|rb|ribu)\b/gi;
  let m;
  while ((m = reK.exec(reply)) !== null) {
    out.add(String(parseInt(m[1]) * 1000));
  }

  // pattern 2: digits with optional . separators, >= 10000
  const reN = /\b(\d{1,3}(?:[.,]\d{3})+|\d{5,})\b/g;
  while ((m = reN.exec(reply)) !== null) {
    const n = parseInt(m[1].replace(/[.,]/g, ''));
    if (n >= 10000) out.add(String(n));
  }

  return Array.from(out);
}

function collectToolPrices(toolCalls) {
  const prices = new Set();
  for (const c of toolCalls || []) {
    const r = c.result;
    if (!r) continue;
    if (Array.isArray(r.products)) {
      for (const p of r.products) {
        if (p.price) prices.add(String(parseInt(p.price)));
      }
    }
    if (Array.isArray(r.promos)) {
      for (const p of r.promos) {
        if (p.discount_amount) prices.add(String(parseInt(p.discount_amount)));
      }
    }
    if (typeof r.fee === 'number') prices.add(String(r.fee));
    if (typeof r.total === 'number') prices.add(String(r.total));
    if (Array.isArray(r.orders)) {
      for (const o of r.orders) if (o.total) prices.add(String(parseInt(o.total)));
    }
    if (Array.isArray(r.items)) {
      for (const it of r.items) if (it.price) prices.add(String(parseInt(it.price)));
    }
  }
  return prices;
}

function checkReply({ reply, toolCalls }) {
  if (!reply) return { passed: false, reason: 'empty_reply' };

  if (hasHesitation(reply)) {
    return { passed: false, reason: 'hesitation' };
  }

  if (hasSpecificEta(reply)) {
    return { passed: false, reason: 'specific_eta' };
  }

  const mentioned = extractPriceMentions(reply);
  if (mentioned.length > 0) {
    const allowed = collectToolPrices(toolCalls);
    const orphan = mentioned.find((p) => !allowed.has(p));
    if (orphan) {
      return { passed: false, reason: 'price_not_in_tool_results', detail: { orphan, allowed: Array.from(allowed) } };
    }
  }

  return { passed: true };
}

module.exports = {
  checkReply,
  extractPriceMentions,
  hasHesitation,
  hasSpecificEta,
  collectToolPrices,
};
```

- [ ] **Step 14.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- aiGuardrails
```

- [ ] **Step 14.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiGuardrails.js backend/__tests__/aiGuardrails.test.js
git commit -m "feat(ai): add post-reply guardrails (hesitation, ETA, price-from-tool checks)"
```

---

## Task 15: AI confidence scorer

**Files:**
- Create: `/home/krttpt/crm/backend/services/aiConfidence.js`
- Create: `/home/krttpt/crm/backend/__tests__/aiConfidence.test.js`

> Threshold = 0.7 (low = aggressive escalation per spec §8). Tunable via `AI_CONFIDENCE_THRESHOLD` env.

- [ ] **Step 15.1: Write failing test**

```javascript
const { scoreReply, shouldEscalate } = require('../services/aiConfidence');

test('high score for clean reply with successful tools', () => {
  const s = scoreReply({
    reply: 'Pilihan papan sukacita 750.000 ya Kak. Mau diproses sekarang?',
    toolCalls: [{ name: 'search_products', result: { count: 2, products: [{ price: 750000 }] } }],
    intent: 'order_intent',
    iterationsCapped: false,
  });
  expect(s).toBeGreaterThanOrEqual(0.7);
});

test('low score for empty reply', () => {
  const s = scoreReply({ reply: '', toolCalls: [], intent: 'other', iterationsCapped: false });
  expect(s).toBeLessThan(0.5);
});

test('low score when iterations capped', () => {
  const s = scoreReply({
    reply: 'oke', toolCalls: [{ name: 'x', result: {} }], intent: 'other', iterationsCapped: true,
  });
  expect(s).toBeLessThan(0.7);
});

test('low score when all tools failed', () => {
  const s = scoreReply({
    reply: 'oke',
    toolCalls: [
      { name: 'search_products', error: 'boom' },
      { name: 'get_shipping_info', error: 'boom' },
    ],
    intent: 'order_intent',
    iterationsCapped: false,
  });
  expect(s).toBeLessThan(0.6);
});

test('shouldEscalate true when score below threshold', () => {
  expect(shouldEscalate(0.5)).toBe(true);
  expect(shouldEscalate(0.85)).toBe(false);
});

test('shouldEscalate respects AI_CONFIDENCE_THRESHOLD env', () => {
  const orig = process.env.AI_CONFIDENCE_THRESHOLD;
  process.env.AI_CONFIDENCE_THRESHOLD = '0.9';
  expect(shouldEscalate(0.85)).toBe(true);
  process.env.AI_CONFIDENCE_THRESHOLD = orig || '';
});
```

- [ ] **Step 15.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiConfidence
```

- [ ] **Step 15.3: Implement `backend/services/aiConfidence.js`**

```javascript
function getThreshold() {
  const v = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD);
  return Number.isFinite(v) ? v : 0.7;
}

/**
 * Score reply quality on [0..1]. Heuristic blend.
 *
 * Components (additive, each capped):
 *   +0.3 reply non-empty and reasonable length (10-800 chars)
 *   +0.2 tool calls succeeded (no errors) OR no tools needed
 *   +0.2 intent matched (not 'unknown' / 'other')
 *   +0.2 not iterationsCapped
 *   +0.1 reply contains a CTA-ish phrase ("kirim link", "tinggal", "yuk", "?")
 *
 * Penalties:
 *   -0.4 if reply is empty
 *   -0.3 if all tool calls errored
 */
function scoreReply({ reply, toolCalls, intent, iterationsCapped }) {
  let s = 0;

  const len = (reply || '').trim().length;
  if (len === 0) {
    s -= 0.4;
  } else if (len >= 10 && len <= 800) {
    s += 0.3;
  } else if (len > 800) {
    s += 0.15;
  } else {
    s += 0.05;
  }

  const calls = toolCalls || [];
  if (calls.length === 0) {
    s += 0.2; // not all turns need tools
  } else {
    const errored = calls.filter((c) => c.error).length;
    if (errored === calls.length) s -= 0.3;
    else if (errored === 0) s += 0.2;
    else s += 0.1;
  }

  if (intent && intent !== 'unknown' && intent !== 'other') s += 0.2;

  if (!iterationsCapped) s += 0.2;

  if (reply && /(\bkirim link\b|\btinggal\b|\byuk\b|\?)/i.test(reply)) s += 0.1;

  // clamp to [0..1]
  return Math.max(0, Math.min(1, s));
}

function shouldEscalate(score) {
  return score < getThreshold();
}

module.exports = { scoreReply, shouldEscalate, getThreshold };
```

- [ ] **Step 15.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- aiConfidence
```

- [ ] **Step 15.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiConfidence.js backend/__tests__/aiConfidence.test.js
git commit -m "feat(ai): add confidence scorer with tunable threshold"
```

---

## Task 16: Notify (Socket.IO emit helpers + logger)

**Files:**
- Create: `/home/krttpt/crm/backend/services/logger.js`
- Create: `/home/krttpt/crm/backend/services/notify.js`
- Create: `/home/krttpt/crm/backend/socket/index.js`
- Create: `/home/krttpt/crm/backend/__tests__/notify.test.js`

- [ ] **Step 16.1: Implement `backend/services/logger.js`**

```javascript
const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  base: { service: 'crm-pilot-backend' },
});

module.exports = logger;
```

- [ ] **Step 16.2: Write failing test for notify**

```javascript
const { notifyMessage, notifyHandover, notifyConvUpdated, setIO, getIO } = require('../services/notify');

const fakeRoom = {
  emit: jest.fn(),
};
const fakeIO = {
  to: jest.fn().mockReturnValue(fakeRoom),
};

beforeEach(() => {
  fakeIO.to.mockClear();
  fakeRoom.emit.mockClear();
  setIO(fakeIO);
});

test('notifyMessage emits crm:message to conv room', () => {
  notifyMessage({ conversation_id: 5, message: { id: 1, body: 'hi' } });
  expect(fakeIO.to).toHaveBeenCalledWith('crm:conv:5');
  expect(fakeRoom.emit).toHaveBeenCalledWith('crm:message', expect.objectContaining({ conversation_id: 5 }));
});

test('notifyHandover emits to inbox + monitor rooms', () => {
  notifyHandover({ conversation_id: 5, reason: 'complaint', summary: 'late delivery' });
  expect(fakeIO.to).toHaveBeenCalledWith('crm:inbox');
  expect(fakeIO.to).toHaveBeenCalledWith('crm:monitor');
  expect(fakeRoom.emit).toHaveBeenCalledWith('crm:handover', expect.objectContaining({ reason: 'complaint' }));
});

test('notifyConvUpdated emits to inbox', () => {
  notifyConvUpdated(7);
  expect(fakeIO.to).toHaveBeenCalledWith('crm:inbox');
  expect(fakeRoom.emit).toHaveBeenCalledWith('crm:conv-updated', { conversation_id: 7 });
});

test('no-op when io not set', () => {
  setIO(null);
  expect(() => notifyMessage({ conversation_id: 1, message: {} })).not.toThrow();
});
```

- [ ] **Step 16.3: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- notify
```

- [ ] **Step 16.4: Implement `backend/services/notify.js`**

```javascript
let io = null;

function setIO(ioInstance) { io = ioInstance; }
function getIO() { return io; }

function notifyMessage({ conversation_id, message }) {
  if (!io) return;
  io.to(`crm:conv:${conversation_id}`).emit('crm:message', { conversation_id, message });
  io.to('crm:inbox').emit('crm:conv-updated', { conversation_id });
}

function notifyHandover({ conversation_id, reason, summary }) {
  if (!io) return;
  const payload = { conversation_id, reason, summary, at: new Date().toISOString() };
  io.to('crm:inbox').emit('crm:handover', payload);
  io.to('crm:monitor').emit('crm:handover', payload);
}

function notifyConvUpdated(conversation_id) {
  if (!io) return;
  io.to('crm:inbox').emit('crm:conv-updated', { conversation_id });
}

function notifyMetrics(payload) {
  if (!io) return;
  io.to('crm:monitor').emit('crm:metrics', payload);
}

module.exports = { setIO, getIO, notifyMessage, notifyHandover, notifyConvUpdated, notifyMetrics };
```

- [ ] **Step 16.5: Implement `backend/socket/index.js`** (room subscriptions)

```javascript
module.exports = function attachSocket(io) {
  io.on('connection', (socket) => {
    socket.on('crm:join-conv', (id) => {
      const n = parseInt(id);
      if (n) socket.join(`crm:conv:${n}`);
    });
    socket.on('crm:leave-conv', (id) => {
      const n = parseInt(id);
      if (n) socket.leave(`crm:conv:${n}`);
    });
    socket.on('crm:join-inbox', () => socket.join('crm:inbox'));
    socket.on('crm:join-monitor', () => socket.join('crm:monitor'));
  });
};
```

- [ ] **Step 16.6: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- notify
```

- [ ] **Step 16.7: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/logger.js backend/services/notify.js backend/socket/index.js \
        backend/__tests__/notify.test.js
git commit -m "feat: add pino logger and Socket.IO notify helpers with room subscriptions"
```

---

## Task 17: AI agent worker (queue polling + orchestration)

**Files:**
- Create: `/home/krttpt/crm/backend/services/aiAgent.js`
- Create: `/home/krttpt/crm/backend/__tests__/aiAgent.test.js`

> This task is the heart of the system. It ties everything together: claim a queue job → load conv state + history → run pre-classifier → if dangerous, handover; else build prompt + call Claude with tools → run post-checker + confidence → send via waClient (or shadow) → write outbound row + metrics → mark queue done.

- [ ] **Step 17.1: Write failing integration test (mocks externals, uses real PG)**

```javascript
process.env.WA_PROVIDER = 'waha';
process.env.AI_GLOBAL_ENABLED = 'true';

jest.mock('../services/claudeClient', () => ({
  generateWithTools: jest.fn(),
}));
jest.mock('../services/geminiClient', () => ({
  classifyIntent: jest.fn(),
  isDangerous: (i) => ['complaint', 'refund', 'cancel', 'angry', 'legal', 'explicit_request_human'].includes(i),
}));
jest.mock('../services/waAdapters/wahaAdapter', () => ({
  name: 'waha',
  sendText: jest.fn().mockResolvedValue({ id: 'sent-msg-id' }),
  parseInbound: jest.fn(),
}));
jest.mock('../db/mysql', () => ({ query: jest.fn().mockResolvedValue([[]]), end: jest.fn().mockResolvedValue(undefined) }));

const pg = require('../db/postgres');
const claude = require('../services/claudeClient');
const gemini = require('../services/geminiClient');
const wahaAdapter = require('../services/waAdapters/wahaAdapter');
const { processOne, claimNextJob } = require('../services/aiAgent');

const TEST_PHONE = `62777${Date.now() % 10000000}`;

async function seedConvAndMessage(body) {
  const conv = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at)
     VALUES ($1, now()) RETURNING id`,
    [TEST_PHONE]
  );
  const convId = conv.rows[0].id;
  const msg = await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, message_type)
     VALUES ($1, 'in', 'customer', $2, 'text') RETURNING id`,
    [convId, body]
  );
  const job = await pg.query(
    `INSERT INTO crm_inbound_queue (message_id, conversation_id) VALUES ($1, $2) RETURNING id`,
    [msg.rows[0].id, convId]
  );
  return { convId, messageId: msg.rows[0].id, jobId: job.rows[0].id };
}

afterAll(async () => {
  await pg.query(`DELETE FROM crm_handovers
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_inbound_queue
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_messages
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.end();
});

beforeEach(() => {
  claude.generateWithTools.mockReset();
  gemini.classifyIntent.mockReset();
  wahaAdapter.sendText.mockClear();
});

test('happy path: clean reply gets sent via waClient', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'order_intent', confidence: 0.9 });
  claude.generateWithTools.mockResolvedValue({
    text: 'Halo Kak, mau pesan papan ya?',
    calls: [],
    usage: { input_tokens: 100, output_tokens: 20 },
    iterationsCapped: false,
  });

  const { jobId, convId } = await seedConvAndMessage('mau pesan papan');
  const result = await processOne();

  expect(result).toMatchObject({ ok: true, sent: true, conversation_id: convId });
  expect(wahaAdapter.sendText).toHaveBeenCalledWith(expect.objectContaining({ phone: TEST_PHONE, text: 'Halo Kak, mau pesan papan ya?' }));

  const out = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 AND sender_type = 'ai'`,
    [convId]
  );
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0].send_status).toBe('sent');

  const job = await pg.query(`SELECT status FROM crm_inbound_queue WHERE id = $1`, [jobId]);
  expect(job.rows[0].status).toBe('done');
});

test('dangerous intent → skip Claude, handover, send safe reply', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'complaint', confidence: 0.95 });

  const { convId } = await seedConvAndMessage('parah banget pesanan saya rusak');
  const result = await processOne();

  expect(result.ok).toBe(true);
  expect(result.handover).toBe(true);
  expect(claude.generateWithTools).not.toHaveBeenCalled();
  expect(wahaAdapter.sendText).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringMatching(/sebentar|tim|panggilkan/i),
  }));

  const ho = await pg.query(`SELECT * FROM crm_handovers WHERE conversation_id = $1`, [convId]);
  expect(ho.rows[0].reason).toBe('complaint');

  const conv = await pg.query(`SELECT ai_paused_until FROM crm_conversations WHERE id = $1`, [convId]);
  expect(conv.rows[0].ai_paused_until).not.toBeNull();
});

test('shadow mode: AI runs but does NOT send', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.8 });
  claude.generateWithTools.mockResolvedValue({
    text: 'Harga mulai 500.000', calls: [], usage: { input_tokens: 50, output_tokens: 10 }, iterationsCapped: false,
  });

  const { convId } = await seedConvAndMessage('berapa harga papan?');
  await pg.query(`UPDATE crm_conversations SET shadow_mode = TRUE WHERE id = $1`, [convId]);

  const result = await processOne();
  expect(result.shadow).toBe(true);
  expect(wahaAdapter.sendText).not.toHaveBeenCalled();

  const out = await pg.query(`SELECT shadow FROM crm_messages WHERE conversation_id = $1 AND sender_type = 'ai'`, [convId]);
  expect(out.rows[0].shadow).toBe(true);
});

test('ai_paused conversation → skip job (no Claude, no send)', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.8 });
  const { convId } = await seedConvAndMessage('hi');
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = now() + INTERVAL '1 hour' WHERE id = $1`, [convId]);

  const result = await processOne();
  expect(result.skipped).toBe('paused');
  expect(claude.generateWithTools).not.toHaveBeenCalled();
});

test('post-check fails → handover instead of send', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.8 });
  claude.generateWithTools.mockResolvedValue({
    text: 'Harga 999.000', // not from any tool
    calls: [{ name: 'search_products', result: { products: [{ price: 500000 }] } }],
    usage: { input_tokens: 50, output_tokens: 10 }, iterationsCapped: false,
  });

  const { convId } = await seedConvAndMessage('berapa harga?');
  const result = await processOne();
  expect(result.handover).toBe(true);
  expect(result.handover_reason).toBe('post_check_failed');
});

test('iteration cap reached → handover', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'order_intent', confidence: 0.7 });
  claude.generateWithTools.mockResolvedValue({
    text: 'oke', calls: [{ name: 'x' }], usage: { input_tokens: 50, output_tokens: 5 }, iterationsCapped: true,
  });

  const { convId } = await seedConvAndMessage('cari mawar');
  const result = await processOne();
  expect(result.handover).toBe(true);
  expect(result.handover_reason).toBe('iteration_cap');
});

test('global kill switch (AI_GLOBAL_ENABLED=false) → skip', async () => {
  process.env.AI_GLOBAL_ENABLED = 'false';
  const { convId } = await seedConvAndMessage('hi');
  const result = await processOne();
  expect(result.skipped).toBe('ai_disabled_global');
  process.env.AI_GLOBAL_ENABLED = 'true';
});

test('claimNextJob respects FOR UPDATE SKIP LOCKED (no double-claim within tx)', async () => {
  // Create two jobs, claim from two clients in parallel — second should get the other or null.
  const a = await seedConvAndMessage('a');
  const b = await seedConvAndMessage('b');

  const c1 = await pg.connect();
  const c2 = await pg.connect();
  try {
    await c1.query('BEGIN');
    await c2.query('BEGIN');
    const j1 = await claimNextJob(c1, 'worker-test-1');
    const j2 = await claimNextJob(c2, 'worker-test-2');
    expect(j1).not.toBeNull();
    expect(j2).not.toBeNull();
    expect(j1.id).not.toBe(j2.id);
    await c1.query('ROLLBACK');
    await c2.query('ROLLBACK');
  } finally {
    c1.release();
    c2.release();
  }
});
```

- [ ] **Step 17.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- aiAgent
```

- [ ] **Step 17.3: Implement `backend/services/aiAgent.js`**

```javascript
const pg = require('../db/postgres');
const waClient = require('./waClient');
const claude = require('./claudeClient');
const gemini = require('./geminiClient');
const tools = require('./aiTools');
const persona = require('./aiPersona');
const guardrails = require('./aiGuardrails');
const confidence = require('./aiConfidence');
const notify = require('./notify');
const logger = require('./logger');
const { resolveByPhone } = require('./contactResolver');

const SAFE_HANDOVER_REPLY = 'Sebentar Kak, aku panggilkan tim ya. Tim Prestisa segera bantu jawab.';
const HISTORY_LIMIT = 20;

function isAiGloballyEnabled() {
  return String(process.env.AI_GLOBAL_ENABLED || 'true').toLowerCase() !== 'false';
}

async function claimNextJob(client, workerId) {
  const r = await client.query(
    `SELECT id, message_id, conversation_id
     FROM crm_inbound_queue
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );
  if (!r.rows[0]) return null;
  const job = r.rows[0];
  await client.query(
    `UPDATE crm_inbound_queue
       SET status = 'processing', locked_at = now(), locked_by = $2, attempts = attempts + 1
       WHERE id = $1`,
    [job.id, workerId]
  );
  return job;
}

async function loadConv(client, convId) {
  const r = await client.query(`SELECT * FROM crm_conversations WHERE id = $1`, [convId]);
  return r.rows[0];
}

async function loadMessage(client, msgId) {
  const r = await client.query(`SELECT * FROM crm_messages WHERE id = $1`, [msgId]);
  return r.rows[0];
}

async function loadHistory(client, convId) {
  const r = await client.query(
    `SELECT direction, sender_type, body
     FROM crm_messages
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT $2`,
    [convId, HISTORY_LIMIT]
  );
  return r.rows.reverse();
}

async function recordOutbound(client, { convId, body, sentMsgId, sendStatus, shadow, metadata }) {
  const r = await client.query(
    `INSERT INTO crm_messages
       (conversation_id, direction, sender_type, body, message_type, send_status, shadow, ai_metadata, waha_message_id)
     VALUES ($1, 'out', 'ai', $2, 'text', $3, $4, $5, $6)
     RETURNING id, created_at`,
    [convId, body, sendStatus, !!shadow, metadata ? JSON.stringify(metadata) : null, sentMsgId || null]
  );
  await client.query(
    `UPDATE crm_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
    [convId]
  );
  return r.rows[0];
}

async function recordHandover(client, { convId, msgId, reason, summary }) {
  const r = await client.query(
    `INSERT INTO crm_handovers (conversation_id, message_id, reason, detail) VALUES ($1, $2, $3, $4) RETURNING id`,
    [convId, msgId || null, reason, summary || null]
  );
  await client.query(
    `UPDATE crm_conversations
       SET ai_paused_until = now() + INTERVAL '24 hours',
           handover_count = handover_count + 1,
           updated_at = now()
     WHERE id = $1`,
    [convId]
  );
  return r.rows[0].id;
}

async function markJob(client, jobId, status, error) {
  await client.query(
    `UPDATE crm_inbound_queue
       SET status = $2, processed_at = now(), error = $3
       WHERE id = $1`,
    [jobId, status, error || null]
  );
}

async function processOne() {
  const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
  const client = await pg.connect();
  let job;
  try {
    await client.query('BEGIN');
    job = await claimNextJob(client, workerId);
    if (!job) {
      await client.query('COMMIT');
      return { ok: true, idle: true };
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    logger.error({ err: err.message }, '[aiAgent] claim failed');
    return { ok: false, error: err.message };
  }

  // process outside the claim tx — long-running call
  const startedAt = Date.now();
  try {
    if (!isAiGloballyEnabled()) {
      const c = await pg.connect();
      try { await markJob(c, job.id, 'skipped', 'ai_disabled_global'); } finally { c.release(); }
      return { ok: true, skipped: 'ai_disabled_global', conversation_id: job.conversation_id };
    }

    const conv = await loadConv(client, job.conversation_id);
    if (!conv) {
      await markJob(client, job.id, 'failed', 'conversation_missing');
      return { ok: false, error: 'conversation_missing' };
    }

    if (conv.ai_paused_until && new Date(conv.ai_paused_until) > new Date()) {
      await markJob(client, job.id, 'skipped', 'paused');
      return { ok: true, skipped: 'paused', conversation_id: conv.id };
    }
    if (!conv.ai_enabled) {
      await markJob(client, job.id, 'skipped', 'ai_disabled_conv');
      return { ok: true, skipped: 'ai_disabled_conv', conversation_id: conv.id };
    }

    const msg = await loadMessage(client, job.message_id);
    if (!msg) {
      await markJob(client, job.id, 'failed', 'message_missing');
      return { ok: false, error: 'message_missing' };
    }

    // Non-text → handover (per spec §8)
    if (msg.message_type && msg.message_type !== 'text') {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'other', summary: `non-text inbound: ${msg.message_type}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'other', summary: `non-text: ${msg.message_type}` });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'non_text', conversation_id: conv.id };
    }

    const inboundText = (msg.body || '').toString().trim();
    if (!inboundText) {
      await markJob(client, job.id, 'skipped', 'empty_inbound');
      return { ok: true, skipped: 'empty_inbound', conversation_id: conv.id };
    }

    // Pre-classifier
    const cls = await gemini.classifyIntent(inboundText);
    logger.info({ convId: conv.id, intent: cls.intent, confidence: cls.confidence }, '[aiAgent] pre-classified');

    if (gemini.isDangerous(cls.intent)) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: cls.intent === 'explicit_request_human' ? 'explicit_request_human' : cls.intent, summary: `intent=${cls.intent}` });
      await sendSafeHandoverReply(client, conv, cls.intent);
      await client.query(`UPDATE crm_conversations SET last_intent = $2 WHERE id = $1`, [conv.id, cls.intent]);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: cls.intent, summary: `pre-classifier flagged ${cls.intent}` });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: cls.intent, conversation_id: conv.id };
    }

    // Build prompt + history
    const resolved = await resolveByPhone(conv.phone);
    const systemPrompt = await persona.buildSystemPrompt({
      conv, customerName: resolved.name, cityHint: null,
    });
    const history = await loadHistory(client, conv.id);
    const messages = persona.buildHistoryMessages(history);
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: inboundText });
    }

    // Call Claude with tools
    const exec = (name, args) => {
      const fn = tools.executors[name];
      if (!fn) return Promise.resolve({ error: `unknown tool ${name}` });
      return Promise.resolve(fn({ args, conv, customer_id: conv.customer_id, phone: conv.phone }));
    };

    let llm;
    try {
      llm = await claude.generateWithTools({
        systemPrompt, messages, tools: tools.declarations, executor: exec, maxIterations: 5,
      });
    } catch (err) {
      logger.error({ err: err.message, convId: conv.id }, '[aiAgent] claude failed');
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'tool_error', summary: `claude error: ${err.message}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'failed', err.message);
      notify.notifyHandover({ conversation_id: conv.id, reason: 'tool_error', summary: err.message });
      return { ok: false, handover: true, handover_id: hoId, handover_reason: 'ai_unavailable' };
    }

    const latencyMs = Date.now() - startedAt;
    const baseMeta = {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      latency_ms: latencyMs,
      tokens_in: llm.usage.input_tokens,
      tokens_out: llm.usage.output_tokens,
      tools_called: llm.calls.map((c) => c.name),
      intent: cls.intent,
      intent_confidence: cls.confidence,
    };

    // Iteration cap → handover (per spec §8)
    if (llm.iterationsCapped) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'tool_error', summary: 'iteration cap reached' });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'iteration_cap', summary: 'iteration cap reached' });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'iteration_cap', conversation_id: conv.id };
    }

    // Tool requested handover (request_handover side effect already paused conv + inserted handover)
    const toolHandover = llm.calls.find((c) => c.name === 'request_handover' && c.result?.ok);
    if (toolHandover) {
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: toolHandover.args.reason, summary: toolHandover.args.summary });
      return { ok: true, handover: true, handover_reason: toolHandover.args.reason, conversation_id: conv.id };
    }

    // Post-checker
    const check = guardrails.checkReply({ reply: llm.text, toolCalls: llm.calls });
    if (!check.passed) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'tool_error', summary: `post_check_failed: ${check.reason}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'post_check_failed', summary: check.reason });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'post_check_failed', detail: check, conversation_id: conv.id };
    }

    // Confidence
    const score = confidence.scoreReply({
      reply: llm.text, toolCalls: llm.calls, intent: cls.intent, iterationsCapped: false,
    });
    if (confidence.shouldEscalate(score)) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'low_confidence', summary: `score=${score.toFixed(2)}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'low_confidence', summary: `score ${score.toFixed(2)}` });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'low_confidence', score, conversation_id: conv.id };
    }

    // Send (or shadow)
    const meta = { ...baseMeta, confidence: score };
    if (conv.shadow_mode) {
      const stored = await recordOutbound(client, { convId: conv.id, body: llm.text, sendStatus: null, shadow: true, metadata: meta });
      await markJob(client, job.id, 'done');
      notify.notifyMessage({ conversation_id: conv.id, message: { ...stored, body: llm.text, direction: 'out', sender_type: 'ai', shadow: true } });
      await client.query(`UPDATE crm_conversations SET last_intent = $2 WHERE id = $1`, [conv.id, cls.intent]);
      return { ok: true, shadow: true, conversation_id: conv.id, score };
    }

    let waResult;
    try {
      waResult = await waClient.sendText({ phone: conv.phone, text: llm.text });
    } catch (err) {
      logger.error({ err: err.message, convId: conv.id }, '[aiAgent] waha send failed');
      await recordOutbound(client, { convId: conv.id, body: llm.text, sendStatus: 'send_failed', metadata: { ...meta, send_error: err.message } });
      await markJob(client, job.id, 'failed', `send failed: ${err.message}`);
      return { ok: false, send_failed: true, conversation_id: conv.id, error: err.message };
    }

    const stored = await recordOutbound(client, {
      convId: conv.id, body: llm.text, sentMsgId: waResult.id, sendStatus: 'sent', metadata: meta,
    });
    await client.query(`UPDATE crm_conversations SET last_intent = $2 WHERE id = $1`, [conv.id, cls.intent]);
    await markJob(client, job.id, 'done');

    notify.notifyMessage({ conversation_id: conv.id, message: {
      id: stored.id, body: llm.text, direction: 'out', sender_type: 'ai', created_at: stored.created_at,
    }});

    return { ok: true, sent: true, conversation_id: conv.id, score };
  } catch (err) {
    logger.error({ err: err.message, jobId: job.id }, '[aiAgent] processing failed');
    try {
      await markJob(client, job.id, 'failed', err.message);
    } catch {}
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function sendSafeHandoverReply(_client, conv, intent) {
  if (conv.shadow_mode) return; // shadow mode: don't send anything
  try {
    await waClient.sendText({ phone: conv.phone, text: SAFE_HANDOVER_REPLY });
  } catch (err) {
    logger.warn({ err: err.message, convId: conv.id, intent }, '[aiAgent] safe handover reply send failed');
  }
}

let workerStop = false;

async function startWorker() {
  workerStop = false;
  const interval = parseInt(process.env.WORKER_POLL_INTERVAL_MS) || 2000;
  logger.info({ interval }, '[aiAgent] worker starting');
  while (!workerStop) {
    try {
      const r = await processOne();
      if (r.idle) {
        await new Promise((res) => setTimeout(res, interval));
      }
    } catch (err) {
      logger.error({ err: err.message }, '[aiAgent] worker tick error');
      await new Promise((res) => setTimeout(res, interval));
    }
  }
  logger.info('[aiAgent] worker stopped');
}

function stopWorker() { workerStop = true; }

async function reapStaleLocks() {
  const ttl = parseInt(process.env.WORKER_LOCK_TTL_MS) || 300000;
  const r = await pg.query(
    `UPDATE crm_inbound_queue
       SET status = 'pending', locked_at = NULL, locked_by = NULL
       WHERE status = 'processing' AND locked_at < now() - INTERVAL '${Math.floor(ttl / 1000)} seconds'
       RETURNING id`
  );
  if (r.rowCount > 0) logger.warn({ count: r.rowCount }, '[aiAgent] reaped stale locks');
  return r.rowCount;
}

module.exports = { processOne, claimNextJob, startWorker, stopWorker, reapStaleLocks };
```

- [ ] **Step 17.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- aiAgent
```

Expected: 8 tests pass. Some take 1-2s due to PG round trips.

- [ ] **Step 17.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/aiAgent.js backend/__tests__/aiAgent.test.js
git commit -m "feat(ai): add agent worker with claim/process/handover/send orchestration"
```

---

## Task 18: Operator API — inbox routes

**Files:**
- Create: `/home/krttpt/crm/backend/routes/inbox.js`
- Create: `/home/krttpt/crm/backend/__tests__/inbox.test.js`

> Routes Plan B will consume: list conversations, fetch messages, send manual reply, takeover, resume AI, list handovers.

- [ ] **Step 18.1: Write failing test**

```javascript
process.env.WAHA_WEBHOOK_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-jwt';

jest.mock('../services/waAdapters/wahaAdapter', () => ({
  name: 'waha',
  sendText: jest.fn().mockResolvedValue({ id: 'manual-msg-id' }),
  parseInbound: jest.fn(),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const inboxRoutes = require('../routes/inbox');
const wahaAdapter = require('../services/waAdapters/wahaAdapter');
const { signToken } = require('../middleware/auth');
const { hashPassword } = require('../services/password');

const TEST_PHONE = `62666${Date.now() % 10000000}`;
const TEST_USER = `inbox_test_${Date.now()}`;
let staffId;
let token;
let app;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const u = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
    [TEST_USER, hashPassword('x')]
  );
  staffId = u.rows[0].id;
  token = signToken({ staff_id: staffId, username: TEST_USER, role: 'admin' });

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/inbox', inboxRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM crm_handovers
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_messages
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
  await pg.end();
});

async function seedConv() {
  const c = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at) VALUES ($1, now())
     ON CONFLICT (phone) DO UPDATE SET last_message_at = now() RETURNING id`,
    [TEST_PHONE]
  );
  const convId = c.rows[0].id;
  await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body)
     VALUES ($1, 'in', 'customer', 'halo')`, [convId]);
  return convId;
}

const auth = () => ({ Cookie: `crm_pilot_token=${token}` });

test('GET /conversations requires auth', async () => {
  const r = await request(app).get('/api/inbox/conversations');
  expect(r.status).toBe(401);
});

test('GET /conversations returns list with last message', async () => {
  await seedConv();
  const r = await request(app).get('/api/inbox/conversations').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.items.length).toBeGreaterThan(0);
  const ours = r.body.items.find((i) => i.phone === TEST_PHONE);
  expect(ours).toBeDefined();
  expect(ours.last_body).toBe('halo');
});

test('GET /conversations/:id/messages returns history', async () => {
  const convId = await seedConv();
  const r = await request(app).get(`/api/inbox/conversations/${convId}/messages`).set(auth());
  expect(r.status).toBe(200);
  expect(r.body.messages.length).toBeGreaterThan(0);
});

test('POST /conversations/:id/send sends manual message and stores as staff', async () => {
  const convId = await seedConv();
  const r = await request(app)
    .post(`/api/inbox/conversations/${convId}/send`)
    .set(auth())
    .send({ body: 'manual reply from operator' });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(wahaAdapter.sendText).toHaveBeenCalledWith(expect.objectContaining({ phone: TEST_PHONE, text: 'manual reply from operator' }));

  const out = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 AND sender_type = 'staff' ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  expect(out.rows[0].body).toBe('manual reply from operator');
  expect(out.rows[0].staff_id).toBe(staffId);
});

test('POST /conversations/:id/takeover pauses AI and assigns staff', async () => {
  const convId = await seedConv();
  const r = await request(app)
    .post(`/api/inbox/conversations/${convId}/takeover`)
    .set(auth());
  expect(r.status).toBe(200);
  const conv = await pg.query(`SELECT ai_paused_until, assigned_staff_id FROM crm_conversations WHERE id = $1`, [convId]);
  expect(conv.rows[0].ai_paused_until).not.toBeNull();
  expect(conv.rows[0].assigned_staff_id).toBe(staffId);
});

test('POST /conversations/:id/resume-ai clears pause', async () => {
  const convId = await seedConv();
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = now() + INTERVAL '1 hour' WHERE id = $1`, [convId]);
  const r = await request(app).post(`/api/inbox/conversations/${convId}/resume-ai`).set(auth());
  expect(r.status).toBe(200);
  const conv = await pg.query(`SELECT ai_paused_until FROM crm_conversations WHERE id = $1`, [convId]);
  expect(conv.rows[0].ai_paused_until).toBeNull();
});

test('GET /handovers returns unresolved list', async () => {
  const convId = await seedConv();
  await pg.query(`INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, 'complaint', 'test')`, [convId]);
  const r = await request(app).get('/api/inbox/handovers').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.items.find((h) => h.conversation_id === convId)).toBeDefined();
});

test('POST /handovers/:id/resolve marks handover resolved', async () => {
  const convId = await seedConv();
  const ho = await pg.query(`INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, 'complaint', 'test') RETURNING id`, [convId]);
  const r = await request(app).post(`/api/inbox/handovers/${ho.rows[0].id}/resolve`).set(auth());
  expect(r.status).toBe(200);
  const after = await pg.query(`SELECT resolved_at, resolved_by FROM crm_handovers WHERE id = $1`, [ho.rows[0].id]);
  expect(after.rows[0].resolved_at).not.toBeNull();
  expect(after.rows[0].resolved_by).toBe(staffId);
});
```

- [ ] **Step 18.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- inbox
```

- [ ] **Step 18.3: Implement `backend/routes/inbox.js`**

```javascript
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const waClient = require('../services/waClient');
const notify = require('../services/notify');
const logger = require('../services/logger');

const router = express.Router();
router.use(requireStaff);

// GET /api/inbox/conversations?status=&search=
router.get('/conversations', async (req, res) => {
  const status = req.query.status;
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const params = [];
  const where = [];
  if (status && ['active', 'closed', 'spam'].includes(status)) {
    params.push(status);
    where.push(`conv.status = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    WITH last_msg AS (
      SELECT DISTINCT ON (conversation_id)
        conversation_id, body, sender_type, created_at
      FROM crm_messages
      ORDER BY conversation_id, id DESC
    ),
    handover_open AS (
      SELECT conversation_id, COUNT(*)::int AS n
      FROM crm_handovers WHERE resolved_at IS NULL GROUP BY conversation_id
    )
    SELECT conv.id, conv.phone, conv.customer_id, conv.status, conv.ai_enabled,
           conv.ai_paused_until, conv.assigned_staff_id, conv.last_message_at,
           conv.last_intent, conv.handover_count, conv.shadow_mode,
           lm.body AS last_body, lm.sender_type AS last_sender, lm.created_at AS last_at,
           COALESCE(ho.n, 0) AS open_handovers
    FROM crm_conversations conv
    LEFT JOIN last_msg lm ON lm.conversation_id = conv.id
    LEFT JOIN handover_open ho ON ho.conversation_id = conv.id
    ${whereSql}
    ORDER BY COALESCE(conv.last_message_at, conv.updated_at) DESC
    LIMIT 200`;
  const { rows } = await pg.query(sql, params);
  const items = search
    ? rows.filter((r) => (r.phone || '').includes(search))
    : rows;
  res.json({ success: true, items });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const { rows } = await pg.query(
    `SELECT id, direction, sender_type, staff_id, body, message_type, attachment_url,
            ai_metadata, shadow, send_status, created_at
     FROM crm_messages WHERE conversation_id = $1
     ORDER BY id ASC LIMIT 500`,
    [id]
  );
  res.json({ success: true, messages: rows });
});

router.post('/conversations/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  const body = (req.body?.body || '').toString().trim();
  if (!id || !body) return res.status(400).json({ success: false, message: 'id and body required' });

  const conv = await pg.query(`SELECT phone FROM crm_conversations WHERE id = $1`, [id]);
  if (!conv.rows[0]) return res.status(404).json({ success: false, message: 'conversation not found' });

  let sent;
  try {
    sent = await waClient.sendText({ phone: conv.rows[0].phone, text: body });
  } catch (err) {
    logger.error({ err: err.message, convId: id }, '[inbox.send] waha failed');
    return res.status(502).json({ success: false, message: `WAHA send failed: ${err.message}` });
  }

  const ins = await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, staff_id, body, message_type, send_status, waha_message_id)
     VALUES ($1, 'out', 'staff', $2, $3, 'text', 'sent', $4)
     RETURNING id, created_at`,
    [id, req.staff.staff_id, body, sent.id || null]
  );
  await pg.query(`UPDATE crm_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [id]);

  notify.notifyMessage({
    conversation_id: id,
    message: { id: ins.rows[0].id, direction: 'out', sender_type: 'staff', staff_id: req.staff.staff_id, body, created_at: ins.rows[0].created_at },
  });
  res.json({ success: true, message_id: ins.rows[0].id });
});

router.post('/conversations/:id/takeover', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_conversations
       SET ai_paused_until = now() + INTERVAL '24 hours',
           assigned_staff_id = $2, updated_at = now()
     WHERE id = $1`,
    [id, req.staff.staff_id]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

router.post('/conversations/:id/resume-ai', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_conversations SET ai_paused_until = NULL, updated_at = now() WHERE id = $1`, [id]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

router.post('/conversations/:id/close', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(`UPDATE crm_conversations SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

router.post('/conversations/:id/shadow', async (req, res) => {
  const id = parseInt(req.params.id);
  const enabled = !!req.body?.enabled;
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(`UPDATE crm_conversations SET shadow_mode = $2, updated_at = now() WHERE id = $1`, [id, enabled]);
  res.json({ success: true, shadow_mode: enabled });
});

router.get('/handovers', async (req, res) => {
  const onlyOpen = req.query.open !== 'false';
  const sql = `
    SELECT h.id, h.conversation_id, h.message_id, h.reason, h.detail, h.created_at,
           h.resolved_at, h.resolved_by, c.phone, c.customer_id
    FROM crm_handovers h
    JOIN crm_conversations c ON c.id = h.conversation_id
    ${onlyOpen ? 'WHERE h.resolved_at IS NULL' : ''}
    ORDER BY h.created_at DESC LIMIT 200`;
  const { rows } = await pg.query(sql);
  res.json({ success: true, items: rows });
});

router.post('/handovers/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_handovers SET resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [id, req.staff.staff_id]
  );
  res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 18.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- inbox
```

- [ ] **Step 18.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/routes/inbox.js backend/__tests__/inbox.test.js
git commit -m "feat(inbox): add operator API — list/messages/send/takeover/resume/handovers"
```

---

## Task 19: Operator API — admin routes (toggles, persona, metrics)

**Files:**
- Create: `/home/krttpt/crm/backend/routes/admin.js`
- Create: `/home/krttpt/crm/backend/__tests__/admin.test.js`

- [ ] **Step 19.1: Write failing test**

```javascript
process.env.JWT_SECRET = 'test-jwt';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const adminRoutes = require('../routes/admin');
const { signToken } = require('../middleware/auth');
const { hashPassword } = require('../services/password');

const TEST_USER = `admin_test_${Date.now()}`;
let staffId, token, app;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const u = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
    [TEST_USER, hashPassword('x')]);
  staffId = u.rows[0].id;
  token = signToken({ staff_id: staffId, username: TEST_USER, role: 'admin' });
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', adminRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM crm_persona_prompts WHERE name LIKE 'test_v%'`);
  await pg.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
  await pg.end();
});

const auth = () => ({ Cookie: `crm_pilot_token=${token}` });

test('GET /personas lists all', async () => {
  const r = await request(app).get('/api/admin/personas').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.items.find((p) => p.active)).toBeDefined();
});

test('POST /personas creates a new version (inactive by default)', async () => {
  const r = await request(app).post('/api/admin/personas').set(auth())
    .send({ name: `test_v${Date.now()}`, prompt_text: 'TEST PROMPT BODY' });
  expect(r.status).toBe(200);
  expect(r.body.id).toBeDefined();
  const row = await pg.query(`SELECT active FROM crm_persona_prompts WHERE id = $1`, [r.body.id]);
  expect(row.rows[0].active).toBe(false);
});

test('POST /personas/:id/activate flips active flag and deactivates others', async () => {
  const ins = await pg.query(
    `INSERT INTO crm_persona_prompts (name, prompt_text, active) VALUES ($1, 'X', false) RETURNING id`,
    [`test_v${Date.now()}_act`]
  );
  const newId = ins.rows[0].id;
  const r = await request(app).post(`/api/admin/personas/${newId}/activate`).set(auth());
  expect(r.status).toBe(200);
  const active = await pg.query(`SELECT id FROM crm_persona_prompts WHERE active = TRUE`);
  expect(active.rows).toHaveLength(1);
  expect(active.rows[0].id).toBe(newId);
});

test('GET /metrics/today returns numbers', async () => {
  const r = await request(app).get('/api/admin/metrics/today').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.metrics).toEqual(expect.objectContaining({
    queue_depth: expect.any(Number),
    inbound_today: expect.any(Number),
    handovers_today: expect.any(Number),
  }));
});

test('POST /ai/global enables/disables global flag in process env', async () => {
  const r = await request(app).post('/api/admin/ai/global').set(auth()).send({ enabled: false });
  expect(r.status).toBe(200);
  expect(process.env.AI_GLOBAL_ENABLED).toBe('false');
  await request(app).post('/api/admin/ai/global').set(auth()).send({ enabled: true });
});
```

- [ ] **Step 19.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- admin
```

- [ ] **Step 19.3: Implement `backend/routes/admin.js`**

```javascript
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);

// ── Persona ──────────────────────────────────────────────────────────────────

router.get('/personas', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, name, active, created_by, created_at,
            LEFT(prompt_text, 200) AS preview
     FROM crm_persona_prompts ORDER BY id DESC LIMIT 50`
  );
  res.json({ success: true, items: rows });
});

router.get('/personas/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT id, name, prompt_text, active, created_by, created_at FROM crm_persona_prompts WHERE id = $1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  res.json({ success: true, persona: rows[0] });
});

router.post('/personas', async (req, res) => {
  const { name, prompt_text } = req.body || {};
  if (!name || !prompt_text) return res.status(400).json({ success: false, message: 'name and prompt_text required' });
  const { rows } = await pg.query(
    `INSERT INTO crm_persona_prompts (name, prompt_text, active, created_by)
     VALUES ($1, $2, FALSE, $3) RETURNING id`,
    [name, prompt_text, req.staff.staff_id]
  );
  res.json({ success: true, id: rows[0].id });
});

router.post('/personas/:id/activate', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE crm_persona_prompts SET active = FALSE WHERE active = TRUE`);
    const r = await client.query(`UPDATE crm_persona_prompts SET active = TRUE WHERE id = $1 RETURNING id`, [id]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'persona not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true, active_id: id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ── Global toggles ───────────────────────────────────────────────────────────

router.post('/ai/global', (req, res) => {
  const enabled = !!req.body?.enabled;
  process.env.AI_GLOBAL_ENABLED = enabled ? 'true' : 'false';
  res.json({ success: true, enabled });
});

router.get('/ai/global', (_req, res) => {
  const enabled = String(process.env.AI_GLOBAL_ENABLED || 'true').toLowerCase() !== 'false';
  res.json({ success: true, enabled });
});

// ── Metrics ──────────────────────────────────────────────────────────────────

router.get('/metrics/today', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [queue, inbound, ai_sent, handovers] = await Promise.all([
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_inbound_queue WHERE status = 'pending'`),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_messages WHERE direction = 'in' AND created_at::date = $1`, [today]),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_messages WHERE sender_type = 'ai' AND shadow = FALSE AND created_at::date = $1`, [today]),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at::date = $1`, [today]),
  ]);
  res.json({
    success: true,
    metrics: {
      date: today,
      queue_depth: queue.rows[0].n,
      inbound_today: inbound.rows[0].n,
      ai_sent_today: ai_sent.rows[0].n,
      handovers_today: handovers.rows[0].n,
    },
  });
});

router.get('/metrics/recent', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT date, total_inbound, total_ai_sent, total_handovers, unique_conversations,
            avg_latency_ms, total_tokens_in, total_tokens_out, cost_usd, handover_breakdown
     FROM crm_ai_metrics_daily ORDER BY date DESC LIMIT 30`
  );
  res.json({ success: true, items: rows });
});

router.get('/metrics/handover-breakdown', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const { rows } = await pg.query(
    `SELECT reason, COUNT(*)::int AS n
     FROM crm_handovers
     WHERE created_at >= now() - INTERVAL '${days} days'
     GROUP BY reason ORDER BY n DESC`
  );
  res.json({ success: true, breakdown: rows, days });
});

module.exports = router;
```

- [ ] **Step 19.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- admin
```

- [ ] **Step 19.5: Commit**

```bash
cd /home/krttpt/crm
git add backend/routes/admin.js backend/__tests__/admin.test.js
git commit -m "feat(admin): add persona mgmt, global AI toggle, today/recent metrics endpoints"
```

---

## Task 20: Health routes

**Files:**
- Create: `/home/krttpt/crm/backend/routes/health.js`
- Create: `/home/krttpt/crm/backend/__tests__/health.test.js`

- [ ] **Step 20.1: Write failing test**

```javascript
const express = require('express');
const request = require('supertest');
const healthRoutes = require('../routes/health');

const app = express();
app.use(healthRoutes);

test('GET /healthz returns ok', async () => {
  const r = await request(app).get('/healthz');
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
});

test('GET /readyz checks PG and Mysql (best-effort)', async () => {
  const r = await request(app).get('/readyz');
  expect([200, 503]).toContain(r.status);
  expect(r.body).toHaveProperty('postgres');
  expect(r.body).toHaveProperty('mysql');
});
```

- [ ] **Step 20.2: Implement `backend/routes/health.js`**

```javascript
const express = require('express');
const pg = require('../db/postgres');
const mysql = require('../db/mysql');

const router = express.Router();

router.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

router.get('/readyz', async (_req, res) => {
  const out = { ok: true, postgres: false, mysql: false };
  try { await pg.query('SELECT 1'); out.postgres = true; } catch (err) { out.ok = false; out.postgres_error = err.message; }
  try { await mysql.query('SELECT 1'); out.mysql = true; } catch (err) { out.ok = false; out.mysql_error = err.message; }
  res.status(out.ok ? 200 : 503).json(out);
});

module.exports = router;
```

- [ ] **Step 20.3: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- health
```

- [ ] **Step 20.4: Commit**

```bash
cd /home/krttpt/crm
git add backend/routes/health.js backend/__tests__/health.test.js
git commit -m "feat: add /healthz and /readyz endpoints"
```

---

## Task 21: Bootstrap (`index.js`) + worker + stale-lock reaper

**Files:**
- Create: `/home/krttpt/crm/backend/index.js`
- Create: `/home/krttpt/crm/backend/__tests__/bootstrap.test.js`

- [ ] **Step 21.1: Write failing smoke test**

```javascript
const request = require('supertest');

// Disable worker spawn during test
process.env.DISABLE_WORKER = 'true';

const { app } = require('../index');

afterAll(async () => {
  // Allow open handles to drain (PG pools are managed in db modules; close at end)
  const pg = require('../db/postgres');
  const mysql = require('../db/mysql');
  await pg.end();
  await mysql.end();
});

test('Express app boots and /healthz responds', async () => {
  const r = await request(app).get('/healthz');
  expect(r.status).toBe(200);
});

test('app has io attached', () => {
  expect(app.get('io')).toBeDefined();
});
```

- [ ] **Step 21.2: Implement `backend/index.js`**

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const logger = require('./services/logger');
const notify = require('./services/notify');
const attachSocket = require('./socket');

const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const inboxRoutes = require('./routes/inbox');
const adminRoutes = require('./routes/admin');
const healthRoutes = require('./routes/health');

const aiAgent = require('./services/aiAgent');

const app = express();
const server = http.createServer(app);

const corsOrigin = process.env.CRM_FRONTEND_ORIGIN || 'https://salesai.prestisa.net';
const io = new Server(server, { cors: { origin: corsOrigin, credentials: true } });

app.set('trust proxy', 1);
app.set('io', io);
notify.setIO(io);

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/admin', adminRoutes);
app.use('/webhook', webhookRoutes);
app.use(healthRoutes);

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled');
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

attachSocket(io);

function startBackgroundJobs() {
  if (process.env.DISABLE_WORKER === 'true') {
    logger.info('worker disabled (DISABLE_WORKER=true)');
    return;
  }
  // start the AI worker loop
  aiAgent.startWorker().catch((err) => logger.error({ err: err.message }, 'worker crashed'));
  // periodic stale-lock reaper (every 60s)
  setInterval(() => {
    aiAgent.reapStaleLocks().catch((err) => logger.warn({ err: err.message }, 'reapStaleLocks failed'));
  }, 60_000);
}

if (require.main === module) {
  const port = parseInt(process.env.CRM_BACKEND_PORT) || 3009;
  server.listen(port, () => {
    logger.info({ port, provider: process.env.WA_PROVIDER || 'waha' }, 'crm-pilot-backend listening');
    startBackgroundJobs();
  });

  // graceful shutdown
  const shutdown = (sig) => {
    logger.info({ sig }, 'shutting down');
    aiAgent.stopWorker();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, server, io };
```

- [ ] **Step 21.3: Run smoke test**

```bash
cd /home/krttpt/crm/backend && npm test -- bootstrap
```

Expected: 2 tests pass.

- [ ] **Step 21.4: Manual smoke run (no live WAHA needed)**

```bash
cd /home/krttpt/crm/backend && DISABLE_WORKER=true node index.js &
sleep 2
curl -s http://localhost:3009/healthz
curl -s http://localhost:3009/readyz | head -100
kill %1 2>/dev/null
```

Expected: `/healthz` returns `{"ok":true,...}` and `/readyz` returns either 200 (both DBs reachable) or 503 with diagnostic.

- [ ] **Step 21.5: Run full suite end-to-end**

```bash
cd /home/krttpt/crm/backend && npm test
```

Expected: every test from Tasks 1-21 passes. If any fail, debug before continuing — never commit failing tests.

- [ ] **Step 21.6: Commit**

```bash
cd /home/krttpt/crm
git add backend/index.js backend/__tests__/bootstrap.test.js
git commit -m "feat: add Express bootstrap with Socket.IO, worker spawn, stale-lock reaper, graceful shutdown"
```

---

## Task 22: Daily metrics rollup script + cron entry

**Files:**
- Create: `/home/krttpt/crm/backend/scripts/dailyMetricsRollup.js`
- Create: `/home/krttpt/crm/backend/__tests__/dailyMetricsRollup.test.js`

> Run via cron at 00:30 each day. Aggregates yesterday's data into `crm_ai_metrics_daily`.

- [ ] **Step 22.1: Write failing test**

```javascript
const pg = require('../db/postgres');
const { rollupForDate } = require('../scripts/dailyMetricsRollup');

const TEST_PHONE = `62555${Date.now() % 10000000}`;
const TEST_DATE = '2026-04-15'; // arbitrary past date

afterAll(async () => {
  await pg.query(`DELETE FROM crm_handovers WHERE conversation_id IN
    (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_messages WHERE conversation_id IN
    (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_ai_metrics_daily WHERE date = $1`, [TEST_DATE]);
  await pg.end();
});

test('rollup aggregates inbound, ai-sent, handovers, tokens for the date', async () => {
  const conv = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at) VALUES ($1, $2) RETURNING id`,
    [TEST_PHONE, `${TEST_DATE} 12:00:00+07`]
  );
  const convId = conv.rows[0].id;
  await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, created_at)
     VALUES ($1, 'in', 'customer', 'hi', $2),
            ($1, 'out', 'ai', 'halo', $3),
            ($1, 'out', 'ai', 'oke', $3)`,
    [convId, `${TEST_DATE} 12:00:01+07`, `${TEST_DATE} 12:00:02+07`]
  );
  await pg.query(
    `UPDATE crm_messages SET ai_metadata = '{"latency_ms":1500,"tokens_in":100,"tokens_out":20}'::jsonb
     WHERE conversation_id = $1 AND sender_type = 'ai'`, [convId]
  );
  await pg.query(
    `INSERT INTO crm_handovers (conversation_id, reason, created_at) VALUES ($1, 'complaint', $2)`,
    [convId, `${TEST_DATE} 13:00:00+07`]
  );

  await rollupForDate(TEST_DATE);

  const r = await pg.query(`SELECT * FROM crm_ai_metrics_daily WHERE date = $1`, [TEST_DATE]);
  const row = r.rows[0];
  expect(row.total_inbound).toBe(1);
  expect(row.total_ai_sent).toBe(2);
  expect(row.total_handovers).toBe(1);
  expect(row.unique_conversations).toBe(1);
  expect(row.total_tokens_in).toBe('200'); // BIGINT returned as string
  expect(row.handover_breakdown).toEqual({ complaint: 1 });
  expect(parseFloat(row.cost_usd)).toBeGreaterThan(0);
});

test('idempotent: re-rolling same date overwrites', async () => {
  await rollupForDate(TEST_DATE);
  await rollupForDate(TEST_DATE);
  const r = await pg.query(`SELECT COUNT(*)::int AS n FROM crm_ai_metrics_daily WHERE date = $1`, [TEST_DATE]);
  expect(r.rows[0].n).toBe(1);
});
```

- [ ] **Step 22.2: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- dailyMetricsRollup
```

- [ ] **Step 22.3: Implement `backend/scripts/dailyMetricsRollup.js`**

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const logger = require('../services/logger');

// Cost: Claude Sonnet 4.6 = $3/M input, $15/M output (per spec §14)
const COST_INPUT_PER_M = 3.0;
const COST_OUTPUT_PER_M = 15.0;

async function rollupForDate(dateStr) {
  const inbound = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages
     WHERE direction = 'in' AND created_at::date = $1::date`, [dateStr]
  );
  const aiSent = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages
     WHERE sender_type = 'ai' AND shadow = FALSE AND created_at::date = $1::date`, [dateStr]
  );
  const handovers = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at::date = $1::date`, [dateStr]
  );
  const uniqConv = await pg.query(
    `SELECT COUNT(DISTINCT conversation_id)::int AS n FROM crm_messages
     WHERE created_at::date = $1::date`, [dateStr]
  );
  const tokens = await pg.query(
    `SELECT
       COALESCE(SUM((ai_metadata->>'tokens_in')::int), 0)::bigint  AS tin,
       COALESCE(SUM((ai_metadata->>'tokens_out')::int), 0)::bigint AS tout,
       COALESCE(AVG((ai_metadata->>'latency_ms')::int), 0)::int    AS avg_lat
     FROM crm_messages
     WHERE sender_type = 'ai' AND ai_metadata IS NOT NULL AND created_at::date = $1::date`,
    [dateStr]
  );
  const breakdown = await pg.query(
    `SELECT reason, COUNT(*)::int AS n
     FROM crm_handovers WHERE created_at::date = $1::date
     GROUP BY reason`, [dateStr]
  );

  const tin = Number(tokens.rows[0].tin || 0);
  const tout = Number(tokens.rows[0].tout || 0);
  const cost = (tin / 1_000_000) * COST_INPUT_PER_M + (tout / 1_000_000) * COST_OUTPUT_PER_M;

  const breakdownObj = {};
  for (const r of breakdown.rows) breakdownObj[r.reason] = r.n;

  await pg.query(
    `INSERT INTO crm_ai_metrics_daily
       (date, total_inbound, total_ai_sent, total_handovers, unique_conversations,
        avg_latency_ms, total_tokens_in, total_tokens_out, cost_usd, handover_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (date) DO UPDATE SET
       total_inbound = EXCLUDED.total_inbound,
       total_ai_sent = EXCLUDED.total_ai_sent,
       total_handovers = EXCLUDED.total_handovers,
       unique_conversations = EXCLUDED.unique_conversations,
       avg_latency_ms = EXCLUDED.avg_latency_ms,
       total_tokens_in = EXCLUDED.total_tokens_in,
       total_tokens_out = EXCLUDED.total_tokens_out,
       cost_usd = EXCLUDED.cost_usd,
       handover_breakdown = EXCLUDED.handover_breakdown`,
    [dateStr, inbound.rows[0].n, aiSent.rows[0].n, handovers.rows[0].n, uniqConv.rows[0].n,
     tokens.rows[0].avg_lat, tin, tout, cost.toFixed(4), breakdownObj]
  );

  return {
    date: dateStr,
    inbound: inbound.rows[0].n,
    ai_sent: aiSent.rows[0].n,
    handovers: handovers.rows[0].n,
    cost_usd: cost.toFixed(4),
  };
}

async function run() {
  // default = yesterday (server local timezone)
  const arg = process.argv[2];
  const date = arg || (() => {
    const d = new Date(Date.now() - 86400000);
    return d.toISOString().slice(0, 10);
  })();
  const result = await rollupForDate(date);
  logger.info(result, '[rollup] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[rollup] failed'); process.exit(1); });
}

module.exports = { rollupForDate };
```

- [ ] **Step 22.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- dailyMetricsRollup
```

- [ ] **Step 22.5: Add cron entry (manual step — user runs)**

Add to user crontab via `! crontab -e` and append:
```
30 0 * * * cd /home/krttpt/crm/backend && /usr/bin/node scripts/dailyMetricsRollup.js >> /home/krttpt/crm/logs/rollup.log 2>&1
```

Verify after editing:
```
crontab -l | grep dailyMetricsRollup
```

Create logs dir:
```
! mkdir -p /home/krttpt/crm/logs
```

- [ ] **Step 22.6: Commit**

```bash
cd /home/krttpt/crm
git add backend/scripts/dailyMetricsRollup.js backend/__tests__/dailyMetricsRollup.test.js
git commit -m "feat: add daily metrics rollup script with cost calculation"
```

---

## Task 23: Eval set runner

**Files:**
- Create: `/home/krttpt/crm/backend/scripts/evalCases.json`
- Create: `/home/krttpt/crm/backend/scripts/runEval.js`
- Create: `/home/krttpt/crm/backend/__tests__/runEval.test.js`

> Spec §11 requires ≥85% pass rate on the eval set before promoting beyond Stage 1. Pilot ships with **20 seed cases**; team grows to 100 from real conversations during Stage 1. Each case asserts on either expected `intent`, expected `handover`, or expected `tool_called`.

- [ ] **Step 23.1: Create `backend/scripts/evalCases.json` (20 seed cases)**

```json
[
  { "id": 1,  "input": "halo, mau pesan papan bunga buat di Jogja",         "expect": { "intent": "order_intent",   "handover": false } },
  { "id": 2,  "input": "kapan barang saya sampai? PO 12345",                "expect": { "intent": "order_status",   "handover": false } },
  { "id": 3,  "input": "berapa harga bouquet untuk anniversary?",           "expect": { "intent": "pricing",        "handover": false, "tool_called": "search_products" } },
  { "id": 4,  "input": "ongkir ke surabaya berapa?",                        "expect": { "intent": "shipping",       "handover": false, "tool_called": "get_shipping_info" } },
  { "id": 5,  "input": "VA saya expired, gimana?",                          "expect": { "intent": "payment",        "handover": false } },
  { "id": 6,  "input": "saya kecewa banget, papan saya layu duluan",        "expect": { "intent": "complaint",      "handover": true } },
  { "id": 7,  "input": "minta refund dong, gak puas",                       "expect": { "intent": "refund",         "handover": true } },
  { "id": 8,  "input": "tolong cancel order saya",                          "expect": { "intent": "cancel",         "handover": true } },
  { "id": 9,  "input": "ngomong sama orang dong, jangan bot",               "expect": { "intent": "explicit_request_human", "handover": true } },
  { "id": 10, "input": "panggilin admin saya mau komplain",                 "expect": { "intent": "explicit_request_human", "handover": true } },
  { "id": 11, "input": "jam buka prestisa kapan ya?",                       "expect": { "intent": "faq",            "handover": false } },
  { "id": 12, "input": "cara order gimana?",                                "expect": { "intent": "faq",            "handover": false } },
  { "id": 13, "input": "ada promo bulan ini?",                              "expect": { "intent": "pricing",        "handover": false, "tool_called": "get_active_promos" } },
  { "id": 14, "input": "papan duka cita di bandung",                        "expect": { "intent": "order_intent",   "handover": false, "tool_called": "search_products" } },
  { "id": 15, "input": "saya mau lapor ke polisi kalau gak diurus",         "expect": { "intent": "legal",          "handover": true } },
  { "id": 16, "input": "WTF marah banget gw layanan kalian busuk",          "expect": { "intent": "angry",          "handover": true } },
  { "id": 17, "input": "boleh kirim 14 feb ke depok? cake ulang tahun",     "expect": { "intent": "order_intent",   "handover": false } },
  { "id": 18, "input": "invoice saya belum sampai email",                   "expect": { "intent": "faq",            "handover": false } },
  { "id": 19, "input": "thanks ya kak",                                     "expect": { "intent": "other",          "handover": false } },
  { "id": 20, "input": "halo",                                              "expect": { "intent": "other",          "handover": false } }
]
```

- [ ] **Step 23.2: Implement `backend/scripts/runEval.js`**

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const gemini = require('../services/geminiClient');
const claude = require('../services/claudeClient');
const tools = require('../services/aiTools');
const persona = require('../services/aiPersona');
const guardrails = require('../services/aiGuardrails');
const confidence = require('../services/aiConfidence');
const logger = require('../services/logger');
const pg = require('../db/postgres');
const mysql = require('../db/mysql');

async function runOne(testCase, systemPrompt) {
  const cls = await gemini.classifyIntent(testCase.input);
  const dangerous = gemini.isDangerous(cls.intent);

  const result = {
    id: testCase.id, input: testCase.input,
    expected: testCase.expect, actual: { intent: cls.intent, handover: dangerous, tools_called: [] },
    passed: false, reasons: [],
  };

  if (testCase.expect.intent && testCase.expect.intent !== cls.intent) {
    result.reasons.push(`intent mismatch: expected ${testCase.expect.intent}, got ${cls.intent}`);
  }
  if (typeof testCase.expect.handover === 'boolean' && testCase.expect.handover !== dangerous) {
    result.reasons.push(`handover mismatch: expected ${testCase.expect.handover}, got ${dangerous}`);
  }

  // For non-dangerous cases, run Claude tool loop to verify expected tool was called
  if (!dangerous && testCase.expect.tool_called) {
    const fakeConv = { id: 0, phone: '628000000000', customer_id: null, last_intent: cls.intent };
    const exec = (name, args) => {
      const fn = tools.executors[name];
      if (!fn) return Promise.resolve({ error: `unknown tool ${name}` });
      return Promise.resolve(fn({ args, conv: fakeConv, customer_id: null, phone: fakeConv.phone }));
    };
    let llm;
    try {
      llm = await claude.generateWithTools({
        systemPrompt,
        messages: [{ role: 'user', content: testCase.input }],
        tools: tools.declarations, executor: exec, maxIterations: 3,
      });
    } catch (err) {
      result.reasons.push(`claude error: ${err.message}`);
      return result;
    }
    result.actual.tools_called = llm.calls.map((c) => c.name);
    result.actual.text = llm.text;
    if (!result.actual.tools_called.includes(testCase.expect.tool_called)) {
      result.reasons.push(`tool_called mismatch: expected ${testCase.expect.tool_called}, got [${result.actual.tools_called.join(',')}]`);
    }

    // Bonus: post-checker should pass
    const check = guardrails.checkReply({ reply: llm.text, toolCalls: llm.calls });
    if (!check.passed) result.reasons.push(`post-check failed: ${check.reason}`);

    const score = confidence.scoreReply({ reply: llm.text, toolCalls: llm.calls, intent: cls.intent, iterationsCapped: false });
    result.actual.confidence = score;
  }

  result.passed = result.reasons.length === 0;
  return result;
}

async function run() {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'evalCases.json'), 'utf8'));
  // build a system prompt once
  const systemPrompt = await persona.buildSystemPrompt({
    conv: { id: 0, phone: '628000000000', customer_id: null, last_intent: null },
    customerName: null, cityHint: null,
  });

  logger.info({ total: cases.length }, '[eval] running');
  const results = [];
  for (const c of cases) {
    try {
      const r = await runOne(c, systemPrompt);
      results.push(r);
      logger.info({ id: r.id, passed: r.passed, reasons: r.reasons }, '[eval] case');
    } catch (err) {
      results.push({ id: c.id, passed: false, reasons: [`unhandled: ${err.message}`] });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const rate = (passed / results.length) * 100;
  const summary = { total: results.length, passed, rate: rate.toFixed(1) + '%' };
  logger.info(summary, '[eval] summary');

  fs.writeFileSync(
    path.join(__dirname, '..', 'eval-results.json'),
    JSON.stringify({ summary, results, ranAt: new Date().toISOString() }, null, 2)
  );

  await pg.end(); await mysql.end();
  if (rate < 85) {
    console.error(`FAIL: ${rate.toFixed(1)}% < 85% required`);
    process.exit(2);
  }
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[eval] failed'); process.exit(1); });
}

module.exports = { runOne, run };
```

- [ ] **Step 23.3: Write smoke test for the runner (mocks externals so it runs in CI without API keys)**

```javascript
jest.mock('../services/geminiClient', () => ({
  classifyIntent: jest.fn(),
  isDangerous: (i) => ['complaint','refund','cancel','angry','legal','explicit_request_human'].includes(i),
}));
jest.mock('../services/claudeClient', () => ({
  generateWithTools: jest.fn(),
}));
jest.mock('../services/aiPersona', () => ({
  buildSystemPrompt: jest.fn().mockResolvedValue('SYS'),
  loadActivePrompt: jest.fn(),
  buildHistoryMessages: jest.fn(() => []),
}));

const gemini = require('../services/geminiClient');
const claude = require('../services/claudeClient');
const { runOne } = require('../scripts/runEval');

beforeEach(() => { gemini.classifyIntent.mockReset(); claude.generateWithTools.mockReset(); });

test('passes when intent matches and handover=false', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.9 });
  claude.generateWithTools.mockResolvedValue({
    text: 'mulai 500.000', calls: [{ name: 'search_products', result: { products: [{ price: 500000 }] } }],
    usage: { input_tokens: 10, output_tokens: 5 }, iterationsCapped: false,
  });
  const r = await runOne(
    { id: 1, input: 'berapa harga?', expect: { intent: 'pricing', handover: false, tool_called: 'search_products' } },
    'SYS'
  );
  expect(r.passed).toBe(true);
});

test('fails when intent mismatches', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'other', confidence: 0.5 });
  const r = await runOne(
    { id: 2, input: 'berapa harga?', expect: { intent: 'pricing', handover: false } },
    'SYS'
  );
  expect(r.passed).toBe(false);
  expect(r.reasons[0]).toMatch(/intent mismatch/);
});

test('passes when dangerous intent triggers handover', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'complaint', confidence: 0.95 });
  const r = await runOne(
    { id: 3, input: 'kecewa', expect: { intent: 'complaint', handover: true } },
    'SYS'
  );
  expect(r.passed).toBe(true);
  expect(claude.generateWithTools).not.toHaveBeenCalled();
});
```

- [ ] **Step 23.4: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- runEval
```

- [ ] **Step 23.5: Run live eval against real APIs (requires `ANTHROPIC_API_KEY` + `GEMINI_API_KEY`)**

```bash
cd /home/krttpt/crm/backend && npm run eval
```

Expected: pass rate ≥ 85%. Check `backend/eval-results.json` for per-case detail. Tune persona / aiKnowledge / classifier prompt and re-run if below threshold.

- [ ] **Step 23.6: Commit**

```bash
cd /home/krttpt/crm
git add backend/scripts/runEval.js backend/scripts/evalCases.json backend/__tests__/runEval.test.js
git commit -m "feat: add eval runner with 20 seed cases (intent + handover + tool_called)"
```

---

## Task 24: Deployment artifacts (PM2 + Caddy + README)

**Files:**
- Create: `/home/krttpt/crm/ecosystem.config.js`
- Create: `/home/krttpt/crm/docs/deployment.md`
- Create: `/home/krttpt/crm/README.md`

> Plan A scope = backend only. Frontend ecosystem entry will be added in Plan B. Caddy block here covers backend `/api/*` and `/webhook/*`; frontend hostname will be added later.

- [ ] **Step 24.1: Create `ecosystem.config.js` at repo root**

```javascript
module.exports = {
  apps: [
    {
      name: 'crm-pilot-backend',
      cwd: '/home/krttpt/crm/backend',
      script: 'index.js',
      exec_mode: 'fork',         // single instance — worker holds queue lock
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/home/krttpt/crm/logs/backend.out.log',
      error_file: '/home/krttpt/crm/logs/backend.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
```

- [ ] **Step 24.2: Create `docs/deployment.md`**

```markdown
# Deployment — Tiara Pilot Backend

## Prereqs

- Node 20+
- PostgreSQL access to `vonage_reports` (creds = same as mitra)
- MySQL read-only user on `prestisa` DB
- WAHA instance running with a dedicated pilot session (separate from mitra's `finance1`)
- API keys: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`
- Caddy as the reverse proxy (never nginx on this VPS)

## First deploy

```bash
cd /home/krttpt/crm
cp .env.example .env  # then fill in secrets
mkdir -p logs
cd backend
npm ci
npm run migrate         # applies 001_init.sql, 002_seed_persona.sql
npm run seed:staff      # creates staff_users + first admin
npm test                # full suite must pass
npm run eval            # live eval — must be ≥85%
```

## Start under PM2

```bash
cd /home/krttpt/crm
pm2 start ecosystem.config.js
pm2 save
pm2 logs crm-pilot-backend
```

## Caddy block

Append to `/etc/caddy/Caddyfile`:

```
salesai.prestisa.net {
    encode gzip

    # Backend API + webhook
    handle /api/* {
        reverse_proxy 127.0.0.1:3009
    }
    handle /webhook/* {
        reverse_proxy 127.0.0.1:3009
    }
    handle /socket.io/* {
        reverse_proxy 127.0.0.1:3009
    }

    # Frontend (Plan B will add this — until then, return 404 or a placeholder page)
    handle {
        respond "Tiara backend is up. Frontend coming." 200
    }
}
```

Reload Caddy:
```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

## WAHA webhook config

Configure WAHA pilot session to POST inbound to:
```
https://salesai.prestisa.net/webhook/waha
Header: X-Webhook-Secret: <value of WAHA_WEBHOOK_SECRET in .env>
```

If using an n8n forwarder, the body shape is `{ wa_jid, push_name, body, waha_message_id, attachment_type, attachment_url, media_url, media_mimetype }` (matches `wahaAdapter.parseInbound`).

## Cron entries

```
30 0 * * * cd /home/krttpt/crm/backend && /usr/bin/node scripts/dailyMetricsRollup.js >> /home/krttpt/crm/logs/rollup.log 2>&1
```

## Rollback / kill switch

```bash
# disable AI globally (per-instance) without restart:
curl -s -X POST -H "Content-Type: application/json" \
  -b "crm_pilot_token=<jwt>" \
  -d '{"enabled": false}' \
  http://localhost:3009/api/admin/ai/global

# re-enable:
curl ... -d '{"enabled": true}' ...

# stop entire backend:
pm2 stop crm-pilot-backend

# rollback to previous commit:
git log --oneline -10
git checkout <prev-sha>
pm2 restart crm-pilot-backend
```

## Health checks

- `GET /healthz` — process alive
- `GET /readyz` — PG + MySQL connectivity
- `GET /api/admin/metrics/today` (auth required) — live counters
```

- [ ] **Step 24.3: Create root `README.md`**

```markdown
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
```

- [ ] **Step 24.4: Verify deployment artifacts (no test, just files exist)**

```bash
ls -la /home/krttpt/crm/ecosystem.config.js /home/krttpt/crm/docs/deployment.md /home/krttpt/crm/README.md
```

- [ ] **Step 24.5: Commit**

```bash
cd /home/krttpt/crm
git add ecosystem.config.js docs/deployment.md README.md
git commit -m "docs: add PM2 ecosystem, Caddy + deployment docs, top-level README"
```

---

## Final verification

- [ ] **Step F.1: Run the entire test suite from scratch**

```bash
cd /home/krttpt/crm/backend && npm test
```

Expected: every test passes (~50+ tests across 22 files). Note any flaky timeouts and re-run if needed; tests should pass deterministically when re-run.

- [ ] **Step F.2: Run live eval one more time**

```bash
cd /home/krttpt/crm/backend && npm run eval
```

Expected: ≥85% pass rate.

- [ ] **Step F.3: Manual end-to-end smoke (no live WAHA — uses curl)**

Start backend (with worker disabled so we control timing):
```bash
cd /home/krttpt/crm/backend && DISABLE_WORKER=true node index.js &
sleep 2
```

Simulate inbound:
```bash
curl -s -X POST http://localhost:3009/webhook/waha \
  -H "X-Webhook-Secret: $(grep ^WAHA_WEBHOOK_SECRET /home/krttpt/crm/.env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"wa_jid":"628999999999@c.us","push_name":"Test","body":"halo, mau pesan papan","waha_message_id":"smoke-1"}'
```

Verify queue row created:
```bash
PGPASSWORD=$(grep ^PG_PASSWORD /home/krttpt/crm/.env | cut -d= -f2) \
psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT id, status, created_at FROM crm_inbound_queue ORDER BY id DESC LIMIT 3;"
```

Tick the worker once manually (will run pre-classifier + Claude — needs API keys + WAHA reachable):
```bash
cd /home/krttpt/crm/backend && node -e "
require('dotenv').config({path:'../.env'});
require('./services/aiAgent').processOne().then(r => { console.log(JSON.stringify(r,null,2)); process.exit(0); });"
```

Expected: result with `ok: true`. If `sent: true`, customer would have received the reply (be careful with real numbers — use a test number).

Stop backend:
```bash
kill %1 2>/dev/null
```

- [ ] **Step F.4: Final commit (if any cleanup) and push**

```bash
cd /home/krttpt/crm
git status
git log --oneline -25
# only push when user confirms — pushing is a shared-state action
```

---

## Spec coverage checklist (self-review)

| Spec section | Implemented in |
|---|---|
| §1 Goal | All tasks |
| §3 Architecture (webhook → queue → worker → reply/handover) | Tasks 7, 17 |
| §3.1 WAHA via abstraction | Task 4 |
| §3.1 PG-backed queue + in-proc worker | Tasks 3, 17, 21 |
| §3.1 Claude Sonnet 4.6 reply | Task 11 |
| §3.1 Gemini 2.5 Flash classifier | Task 12 |
| §4 DB schema (7 tables + migrations table) | Task 3 |
| §5 File layout | Tasks 1-22 |
| §5.1 Per-message data flow | Task 17 |
| §6 9 tools catalog | Tasks 9, 10 |
| §6 Tool guardrails (read-only, scoped, validated returns) | Tasks 9, 10 |
| §7 Persona stored in DB, versioned | Tasks 3, 13, 19 |
| §7 Dynamic context injection | Task 13 |
| §8 Pre-classifier dangerous-intent → handover | Tasks 12, 17 |
| §8 Post-checker (hesitation, ETA, price-from-tool) | Task 14 |
| §8 Confidence threshold (default 0.7) | Task 15 |
| §8 Tool loop max 5 iterations | Tasks 11, 17 |
| §8 Non-text → handover | Task 17 |
| §9 Webhook idempotency | Task 7 |
| §9 WAHA send retry | Task 17 (caught + recorded; explicit retry per spec is single attempt today — see open question) |
| §9 Claude 429/5xx retry | Task 11 |
| §9 FOR UPDATE SKIP LOCKED | Task 17 |
| §9 Stale-lock reaper | Tasks 17, 21 |
| §9 Persona missing fallback | Task 13 (throws hard fail; future improvement: inline default) |
| §10 pino logging | Task 16 |
| §10 Daily rollup metrics | Task 22 |
| §10 Operator API for inbox/handovers | Task 18 |
| §10 Operator API admin (toggle, persona, metrics) | Task 19 |
| §11 Unit tests | Throughout |
| §11 Integration test (webhook → queue → worker) | Tasks 7, 17 |
| §11 Eval set ≥85% | Task 23 |
| §12 Stage 1 shadow mode flag | Tasks 3, 17, 18 |
| §12 Kill switch ENV | Tasks 17, 19 |
| §13 PM2 fork + Caddy + ENV file | Task 24 |
| §13 Migration runner | Task 3 |

**Out of scope for Plan A (deferred to Plan B or future work):**
- Frontend `/inbox`, `/inbox/[id]`, `/ai-monitor`, `/ai-settings` UI pages — Plan B
- Promo settings dashboard (sub-spec)
- FAQ refresh pipeline (sub-spec)
- Phase 2 Meta Cloud API real implementation
- Conversation summarization for context >20 messages (Stage 1 = truncate, per spec §15 Q7)

**Known minor gaps (intentional, low risk):**
- WAHA send retry: implemented as single attempt + record `send_failed` rather than 3-retry. If WAHA reliability becomes an issue in shadow mode, wrap `waClient.sendText` in `withRetry` (mirrors `claudeClient.withRetry`).
- Persona missing fallback: `loadActivePrompt()` throws if no active row. Migration 002 seeds `tiara_v1` so this only fires on accidental delete. If desired, add inline default to Task 13's `loadActivePrompt`.
- Tool error 3-in-a-row → handover (per spec §5.1): not yet tracked across calls; current behavior surfaces tool error to LLM via tool_result is_error, and confidence scorer naturally drops if all tools fail. If too noisy in Stage 1, add a counter on `crm_inbound_queue.attempts` and escalate after 3 failed jobs.

---

## Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Use `superpowers:subagent-driven-development`. Best when you want to spread work across sessions or hand off to another engineer.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Batch execution with checkpoints for review. Best when you want to plow through and stay close to the work.

Pick one. The plan is structured so either approach works; commit boundaries between tasks are checkpoints either way.

## Task 25: WAHA session admin API (multi-session)

**Files:**
- Create: `/home/krttpt/crm/backend/services/wahaAdmin.js`
- Create: `/home/krttpt/crm/backend/middleware/requireAdmin.js`
- Create: `/home/krttpt/crm/backend/routes/wahaAdmin.js`
- Create: `/home/krttpt/crm/backend/__tests__/wahaAdmin.test.js`
- Modify: `/home/krttpt/crm/backend/index.js` (mount route)

> Admin-only routes that proxy WAHA's session management API (list / create+start / stop / restart / delete / QR). Multi-session support: operator can manage several WhatsApp numbers (pilot, backup, test). Pilot's *active* session for the AI agent is still controlled by `.env`'s `WAHA_SESSION` — switching active session is a deliberate restart-required action and out of scope for this UI.

- [ ] **Step 25.1: Implement `backend/middleware/requireAdmin.js`**

```javascript
const { requireStaff } = require('./auth');

function requireAdmin(req, res, next) {
  requireStaff(req, res, (err) => {
    if (err) return next(err);
    if (req.staff?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin role required' });
    }
    next();
  });
}

module.exports = { requireAdmin };
```

- [ ] **Step 25.2: Write failing test `backend/__tests__/wahaAdmin.test.js`**

```javascript
process.env.JWT_SECRET = 'test-jwt';
process.env.WAHA_API_URL = 'http://waha.test';
process.env.WAHA_API_KEY = 'test-key';

global.fetch = jest.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const wahaAdminRoutes = require('../routes/wahaAdmin');
const { signToken } = require('../middleware/auth');
const { hashPassword } = require('../services/password');

const ADMIN_USER = `waha_admin_${Date.now()}`;
const STAFF_USER = `waha_staff_${Date.now()}`;
let adminToken, staffToken, app, adminId, staffId;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const a = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
    [ADMIN_USER, hashPassword('x')]);
  adminId = a.rows[0].id;
  const s = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'staff') RETURNING id`,
    [STAFF_USER, hashPassword('x')]);
  staffId = s.rows[0].id;
  adminToken = signToken({ staff_id: adminId, username: ADMIN_USER, role: 'admin' });
  staffToken = signToken({ staff_id: staffId, username: STAFF_USER, role: 'staff' });

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/waha', wahaAdminRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[adminId, staffId]]);
  await pg.end();
});

beforeEach(() => { fetch.mockReset(); });

const adminAuth = () => ({ Cookie: `crm_pilot_token=${adminToken}` });
const staffAuth = () => ({ Cookie: `crm_pilot_token=${staffToken}` });

function mockJsonResponse(body, status = 200) {
  fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
  });
}

test('GET /sessions requires admin role (staff = 403)', async () => {
  const r = await request(app).get('/api/admin/waha/sessions').set(staffAuth());
  expect(r.status).toBe(403);
});

test('GET /sessions returns proxied list', async () => {
  mockJsonResponse([
    { name: 'tiara-pilot', status: 'WORKING', engine: { engine: 'WEBJS' } },
    { name: 'backup', status: 'STOPPED' },
  ]);
  const r = await request(app).get('/api/admin/waha/sessions').set(adminAuth());
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.sessions).toHaveLength(2);
  expect(fetch).toHaveBeenCalledWith(
    'http://waha.test/api/sessions',
    expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
  );
});

test('POST /sessions creates and starts new session', async () => {
  mockJsonResponse({ name: 'pilot-2', status: 'STARTING' }, 201);
  mockJsonResponse({ ok: true });
  const r = await request(app).post('/api/admin/waha/sessions').set(adminAuth())
    .send({ name: 'pilot-2' });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe('http://waha.test/api/sessions');
  expect(fetch.mock.calls[1][0]).toBe('http://waha.test/api/sessions/pilot-2/start');
});

test('POST /sessions rejects invalid name', async () => {
  const r = await request(app).post('/api/admin/waha/sessions').set(adminAuth())
    .send({ name: 'bad name with space' });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/name/);
  expect(fetch).not.toHaveBeenCalled();
});

test('GET /sessions/:name returns details', async () => {
  mockJsonResponse({ name: 'tiara-pilot', status: 'SCAN_QR_CODE', me: null });
  const r = await request(app).get('/api/admin/waha/sessions/tiara-pilot').set(adminAuth());
  expect(r.status).toBe(200);
  expect(r.body.session.status).toBe('SCAN_QR_CODE');
});

test('GET /sessions/:name/qr proxies binary PNG', async () => {
  fetch.mockResolvedValueOnce({
    ok: true, status: 200,
    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
  });
  const r = await request(app).get('/api/admin/waha/sessions/tiara-pilot/qr').set(adminAuth());
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/image\/png/);
  expect(r.body.length).toBe(4);
});

test('GET /qr returns 409 when session not in SCAN_QR_CODE', async () => {
  fetch.mockResolvedValueOnce({
    ok: false, status: 422,
    json: async () => ({ message: 'Session is not in SCAN_QR_CODE state' }),
    text: async () => 'Session is not in SCAN_QR_CODE state',
    headers: { get: () => 'application/json' },
  });
  const r = await request(app).get('/api/admin/waha/sessions/tiara-pilot/qr').set(adminAuth());
  expect(r.status).toBe(409);
  expect(r.body.message).toMatch(/SCAN_QR_CODE/);
});

test('POST /sessions/:name/stop proxies', async () => {
  mockJsonResponse({ ok: true });
  const r = await request(app).post('/api/admin/waha/sessions/tiara-pilot/stop').set(adminAuth());
  expect(r.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    'http://waha.test/api/sessions/tiara-pilot/stop',
    expect.objectContaining({ method: 'POST' })
  );
});

test('POST /sessions/:name/restart proxies', async () => {
  mockJsonResponse({ ok: true });
  const r = await request(app).post('/api/admin/waha/sessions/tiara-pilot/restart').set(adminAuth());
  expect(r.status).toBe(200);
});

test('DELETE /sessions/:name proxies and rejects active env session', async () => {
  process.env.WAHA_SESSION = 'tiara-pilot';
  const r = await request(app).delete('/api/admin/waha/sessions/tiara-pilot').set(adminAuth());
  expect(r.status).toBe(409);
  expect(r.body.message).toMatch(/active session/i);

  mockJsonResponse({ ok: true });
  const r2 = await request(app).delete('/api/admin/waha/sessions/other-session').set(adminAuth());
  expect(r2.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    'http://waha.test/api/sessions/other-session',
    expect.objectContaining({ method: 'DELETE' })
  );
});

test('upstream WAHA error surfaced with detail', async () => {
  fetch.mockResolvedValueOnce({
    ok: false, status: 500,
    json: async () => ({ message: 'WAHA boom' }),
    text: async () => 'WAHA boom',
    headers: { get: () => 'application/json' },
  });
  const r = await request(app).get('/api/admin/waha/sessions').set(adminAuth());
  expect(r.status).toBe(502);
  expect(r.body.upstream_status).toBe(500);
});
```

- [ ] **Step 25.3: Run test to verify FAIL**

```bash
cd /home/krttpt/crm/backend && npm test -- wahaAdmin
```

- [ ] **Step 25.4: Implement `backend/services/wahaAdmin.js`**

```javascript
const BASE = () => process.env.WAHA_API_URL || 'http://localhost:3000';
const KEY = () => process.env.WAHA_API_KEY || '';

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (KEY()) h['X-Api-Key'] = KEY();
  return h;
}

async function callJson(method, path, body) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function listSessions() { return callJson('GET', '/api/sessions'); }

async function createSession(name) {
  // WAHA versions vary: some accept POST /api/sessions {name}, others POST /api/sessions/{name}.
  // Try the modern body form first; the started-by-default flag is also supported but explicit start is safer.
  return callJson('POST', '/api/sessions', { name });
}

async function startSession(name)   { return callJson('POST', `/api/sessions/${encodeURIComponent(name)}/start`); }
async function stopSession(name)    { return callJson('POST', `/api/sessions/${encodeURIComponent(name)}/stop`); }
async function restartSession(name) { return callJson('POST', `/api/sessions/${encodeURIComponent(name)}/restart`); }
async function deleteSession(name)  { return callJson('DELETE', `/api/sessions/${encodeURIComponent(name)}`); }
async function getSessionDetails(name) { return callJson('GET', `/api/sessions/${encodeURIComponent(name)}`); }

/**
 * Fetch QR PNG bytes. Returns { ok, status, body: Buffer | null, contentType }.
 * Tries modern path first (`/api/{session}/auth/qr?format=image`) — fall back to
 * legacy (`/api/sessions/{session}/auth/qr?format=image`) on 404.
 */
async function getSessionQr(name) {
  const tryPath = async (path) => {
    const res = await fetch(`${BASE()}${path}`, { method: 'GET', headers: headers() });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      let detailText = '';
      try { detailText = await res.text(); } catch {}
      return { ok: false, status: res.status, body: null, contentType, detail: detailText };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: 200, body: buf, contentType };
  };

  const modern = `/api/${encodeURIComponent(name)}/auth/qr?format=image`;
  const legacy = `/api/sessions/${encodeURIComponent(name)}/auth/qr?format=image`;
  let r = await tryPath(modern);
  if (r.status === 404) r = await tryPath(legacy);
  return r;
}

const VALID_NAME = /^[a-zA-Z0-9_-]{2,64}$/;
function isValidSessionName(name) { return VALID_NAME.test(String(name || '')); }

module.exports = {
  listSessions, createSession, startSession, stopSession, restartSession,
  deleteSession, getSessionDetails, getSessionQr, isValidSessionName,
};
```

- [ ] **Step 25.5: Implement `backend/routes/wahaAdmin.js`**

```javascript
const express = require('express');
const { requireAdmin } = require('../middleware/requireAdmin');
const wahaAdmin = require('../services/wahaAdmin');
const logger = require('../services/logger');

const router = express.Router();
router.use(requireAdmin);

function surfaceUpstream(res, r, fallbackMsg) {
  const detail = (r.data && r.data.message) || r.data || fallbackMsg;
  return res.status(502).json({
    success: false,
    upstream_status: r.status,
    message: typeof detail === 'string' ? detail : fallbackMsg,
  });
}

router.get('/sessions', async (_req, res) => {
  const r = await wahaAdmin.listSessions();
  if (!r.ok) return surfaceUpstream(res, r, 'WAHA list failed');
  res.json({ success: true, sessions: r.data });
});

router.get('/sessions/:name', async (req, res) => {
  const r = await wahaAdmin.getSessionDetails(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'WAHA details failed');
  res.json({ success: true, session: r.data });
});

router.post('/sessions', async (req, res) => {
  const name = (req.body?.name || '').toString().trim();
  if (!wahaAdmin.isValidSessionName(name)) {
    return res.status(400).json({ success: false, message: 'invalid session name (2-64 chars, [a-zA-Z0-9_-])' });
  }
  const create = await wahaAdmin.createSession(name);
  if (!create.ok) return surfaceUpstream(res, create, 'WAHA create failed');
  // explicit start (some WAHA configs don't auto-start)
  const start = await wahaAdmin.startSession(name);
  if (!start.ok && start.status !== 422) {
    // 422 = already started; tolerate
    return surfaceUpstream(res, start, 'WAHA start failed');
  }
  logger.info({ name }, '[wahaAdmin] session created+started');
  res.json({ success: true, session: create.data });
});

router.post('/sessions/:name/start', async (req, res) => {
  const r = await wahaAdmin.startSession(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'start failed');
  res.json({ success: true });
});

router.post('/sessions/:name/stop', async (req, res) => {
  const r = await wahaAdmin.stopSession(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'stop failed');
  res.json({ success: true });
});

router.post('/sessions/:name/restart', async (req, res) => {
  const r = await wahaAdmin.restartSession(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'restart failed');
  res.json({ success: true });
});

router.delete('/sessions/:name', async (req, res) => {
  const name = req.params.name;
  const activeName = process.env.WAHA_SESSION;
  if (activeName && name === activeName) {
    return res.status(409).json({
      success: false,
      message: `Refused: "${name}" is the active session for the AI agent (WAHA_SESSION). Edit .env and restart backend before deleting.`,
    });
  }
  const r = await wahaAdmin.deleteSession(name);
  if (!r.ok) return surfaceUpstream(res, r, 'delete failed');
  res.json({ success: true });
});

router.get('/sessions/:name/qr', async (req, res) => {
  const r = await wahaAdmin.getSessionQr(req.params.name);
  if (!r.ok) {
    if (r.status === 422 || (r.detail || '').toString().match(/SCAN_QR_CODE/i)) {
      return res.status(409).json({
        success: false,
        message: 'Session not in SCAN_QR_CODE state. Stop+restart it to regenerate, or it may already be authenticated.',
        upstream_status: r.status,
      });
    }
    return res.status(502).json({
      success: false,
      upstream_status: r.status,
      message: 'WAHA QR endpoint failed',
    });
  }
  res.set('Content-Type', r.contentType || 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(r.body);
});

module.exports = router;
```

- [ ] **Step 25.6: Mount route in `backend/index.js`**

In the existing `backend/index.js`, add the require and mount:

```javascript
const wahaAdminRoutes = require('./routes/wahaAdmin');
// ...inside app.use stack, near other admin route...
app.use('/api/admin/waha', wahaAdminRoutes);
```

- [ ] **Step 25.7: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- wahaAdmin
```

Expected: 11 tests pass.

- [ ] **Step 25.8: Live smoke (optional — needs WAHA reachable)**

```bash
cd /home/krttpt/crm/backend && DISABLE_WORKER=true node index.js &
sleep 2
TOKEN=$(curl -s -X POST http://localhost:3009/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"finance","password":"Bunga123"}' \
  -c - | grep crm_pilot_token | awk '{print $7}')
curl -s -b "crm_pilot_token=$TOKEN" http://localhost:3009/api/admin/waha/sessions | head -100
kill %1 2>/dev/null
```

Expected: JSON list of WAHA sessions (could be empty if none yet).

- [ ] **Step 25.9: Commit**

```bash
cd /home/krttpt/crm
git add backend/services/wahaAdmin.js backend/middleware/requireAdmin.js \
        backend/routes/wahaAdmin.js backend/__tests__/wahaAdmin.test.js \
        backend/index.js
git commit -m "feat(waha-admin): add multi-session admin API (list/create/qr/stop/restart/delete)"
```

---

## Task 26: Standalone HTML UI for WAHA session management

**Files:**
- Create: `/home/krttpt/crm/backend/public/login.html`
- Create: `/home/krttpt/crm/backend/public/waha-sessions.html`
- Modify: `/home/krttpt/crm/backend/index.js` (serve `/admin/*` static)
- Create: `/home/krttpt/crm/backend/__tests__/staticAdmin.test.js`

> Single-page HTML UI bundled with the backend. No build step. Auto-refreshes session list every 5s and QR every 3s. Lives at `https://salesai.prestisa.net/admin/waha-sessions.html`. Will be replaced by the Next.js sub-page in Plan B; until then this is the operational tool to provision the pilot WhatsApp number.

- [ ] **Step 26.1: Create `backend/public/login.html`**

```html
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Login — Tiara Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f7f7f8; margin: 0; }
    .wrap { max-width: 360px; margin: 80px auto; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    h1 { margin: 0 0 24px; font-size: 20px; }
    label { display: block; margin: 12px 0 4px; color: #444; }
    input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 15px; }
    button { width: 100%; margin-top: 20px; padding: 12px; background: #0a7; color: #fff; border: 0; border-radius: 6px; font-size: 15px; cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    .err { color: #c33; margin-top: 12px; font-size: 13px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Tiara Admin Login</h1>
    <form id="f">
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" required>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required>
      <button id="b" type="submit">Login</button>
      <div class="err" id="e"></div>
    </form>
  </div>
  <script>
    const f = document.getElementById('f');
    const b = document.getElementById('b');
    const e = document.getElementById('e');
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      e.textContent = '';
      b.disabled = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Login gagal');
        const next = new URLSearchParams(location.search).get('next') || '/admin/waha-sessions.html';
        location.href = next;
      } catch (err) {
        e.textContent = err.message;
      } finally {
        b.disabled = false;
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 26.2: Create `backend/public/waha-sessions.html`**

```html
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>WAHA Sessions — Tiara Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { --fg: #222; --muted: #777; --bg: #f7f7f8; --card: #fff; --line: #e5e5ea; --green: #0a7; --red: #c33; --yellow: #d80; }
    * { box-sizing: border-box; }
    body { font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 0; }
    header { background: #fff; border-bottom: 1px solid var(--line); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    header .who { color: var(--muted); font-size: 13px; }
    main { max-width: 1100px; margin: 24px auto; padding: 0 24px; }
    .row { display: grid; grid-template-columns: 1fr 360px; gap: 24px; }
    @media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
    h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
    .session { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f3; gap: 12px; }
    .session:last-child { border: 0; }
    .session .name { font-weight: 500; }
    .session .status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #eee; color: var(--muted); }
    .status.WORKING { background: #d6f5ea; color: var(--green); }
    .status.SCAN_QR_CODE { background: #fff1cc; color: var(--yellow); }
    .status.STOPPED, .status.STOPPED_BY_USER { background: #f0f0f3; color: var(--muted); }
    .status.FAILED, .status.UNAUTHORIZED { background: #fde2e2; color: var(--red); }
    .actions { display: flex; gap: 6px; }
    button { font: inherit; padding: 6px 10px; border: 1px solid var(--line); background: #fff; border-radius: 6px; cursor: pointer; }
    button:hover { background: #fafafa; }
    button.primary { background: var(--green); border-color: var(--green); color: #fff; }
    button.danger { color: var(--red); }
    button:disabled { opacity: .5; cursor: wait; }
    .new { display: flex; gap: 8px; margin-top: 14px; }
    .new input { flex: 1; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 14px; }
    .qr-card { text-align: center; }
    .qr-card img { width: 240px; height: 240px; border: 1px solid var(--line); padding: 8px; background: #fff; border-radius: 8px; }
    .qr-card .hint { color: var(--muted); font-size: 13px; margin-top: 10px; }
    .qr-card.empty { color: var(--muted); padding: 60px 20px; }
    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #222; color: #fff; padding: 10px 18px; border-radius: 6px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 80%; }
    .toast.show { opacity: 1; }
    .toast.err { background: var(--red); }
    .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
    a.logout { color: var(--muted); text-decoration: none; font-size: 13px; }
    a.logout:hover { color: var(--red); }
  </style>
</head>
<body>
  <header>
    <h1>Tiara — WAHA Sessions</h1>
    <span><span class="who" id="who"></span> · <a class="logout" href="#" id="logout">Logout</a></span>
  </header>
  <main>
    <div class="row">
      <section class="card">
        <h2>Sessions</h2>
        <div id="list"></div>
        <div class="new">
          <input id="newName" placeholder="nama session baru (huruf, angka, _ atau -)" maxlength="64">
          <button class="primary" id="createBtn">Create + Start</button>
        </div>
        <div class="meta" id="activeNote"></div>
      </section>

      <section class="card qr-card empty" id="qrCard">
        <div id="qrInner">Pilih session yang status-nya <code>SCAN_QR_CODE</code> untuk lihat QR.</div>
      </section>
    </div>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const ACTIVE_ENV_NAME = ''; // server can't pass at static-time; UI just labels via /sessions if name matches
    let selectedSession = null;
    let qrTimer = null;
    let listTimer = null;

    function toast(msg, isErr) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.toggle('err', !!isErr);
      t.classList.add('show');
      clearTimeout(t._h);
      t._h = setTimeout(() => t.classList.remove('show'), 2400);
    }

    async function api(path, method = 'GET', body) {
      const opts = { method, credentials: 'include', headers: {} };
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const res = await fetch(path, opts);
      if (res.status === 401) { location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname); throw new Error('unauthenticated'); }
      const text = await res.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return data;
    }

    async function loadMe() {
      try {
        const me = await api('/api/auth/me');
        document.getElementById('who').textContent = `${me.user.username} (${me.user.role})`;
      } catch {}
    }

    async function loadSessions() {
      try {
        const r = await api('/api/admin/waha/sessions');
        renderSessions(r.sessions || []);
      } catch (err) {
        toast(err.message, true);
      }
    }

    function renderSessions(list) {
      const container = document.getElementById('list');
      if (!list.length) {
        container.innerHTML = '<div class="meta">Belum ada session. Buat di bawah.</div>';
        return;
      }
      container.innerHTML = '';
      for (const s of list) {
        const div = document.createElement('div');
        div.className = 'session';
        const isQrReady = s.status === 'SCAN_QR_CODE';
        div.innerHTML = `
          <div>
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="meta">${s.engine?.engine || ''} ${s.me?.id ? '· ' + escapeHtml(s.me.id) : ''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="status ${escapeHtml(s.status || '')}">${escapeHtml(s.status || '?')}</span>
            <div class="actions">
              ${isQrReady ? `<button data-act="qr">QR</button>` : ''}
              <button data-act="restart">Restart</button>
              <button data-act="stop">Stop</button>
              <button data-act="delete" class="danger">Delete</button>
            </div>
          </div>`;
        div.querySelectorAll('button[data-act]').forEach((btn) => {
          btn.addEventListener('click', () => act(s.name, btn.getAttribute('data-act'), btn));
        });
        container.appendChild(div);
      }
    }

    async function act(name, action, btn) {
      btn.disabled = true;
      try {
        if (action === 'qr') {
          showQr(name);
        } else if (action === 'restart') {
          await api(`/api/admin/waha/sessions/${encodeURIComponent(name)}/restart`, 'POST');
          toast(`Restarted ${name}`);
        } else if (action === 'stop') {
          await api(`/api/admin/waha/sessions/${encodeURIComponent(name)}/stop`, 'POST');
          toast(`Stopped ${name}`);
        } else if (action === 'delete') {
          if (!confirm(`Delete session "${name}" dari WAHA?`)) return;
          await api(`/api/admin/waha/sessions/${encodeURIComponent(name)}`, 'DELETE');
          if (selectedSession === name) hideQr();
          toast(`Deleted ${name}`);
        }
        loadSessions();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    }

    function showQr(name) {
      selectedSession = name;
      const card = document.getElementById('qrCard');
      card.classList.remove('empty');
      const refresh = () => {
        const url = `/api/admin/waha/sessions/${encodeURIComponent(name)}/qr?ts=${Date.now()}`;
        const inner = document.getElementById('qrInner');
        inner.innerHTML = `
          <div style="font-weight:500;margin-bottom:10px;">QR untuk: ${escapeHtml(name)}</div>
          <img id="qrImg" src="${url}" alt="QR" onerror="this.replaceWith(document.createTextNode('QR belum siap atau session sudah connected — refresh status.'))">
          <div class="hint">Buka WhatsApp di HP → Settings → Linked Devices → Link a Device, lalu scan.</div>
          <div style="margin-top:12px;"><button onclick="hideQr()">Close</button></div>`;
      };
      refresh();
      clearInterval(qrTimer);
      qrTimer = setInterval(refresh, 3000);
    }

    function hideQr() {
      selectedSession = null;
      clearInterval(qrTimer);
      const card = document.getElementById('qrCard');
      card.classList.add('empty');
      document.getElementById('qrInner').textContent = 'Pilih session yang status-nya SCAN_QR_CODE untuk lihat QR.';
    }
    window.hideQr = hideQr;

    document.getElementById('createBtn').addEventListener('click', async (ev) => {
      const name = document.getElementById('newName').value.trim();
      if (!name) return toast('Nama session wajib', true);
      ev.target.disabled = true;
      try {
        await api('/api/admin/waha/sessions', 'POST', { name });
        document.getElementById('newName').value = '';
        toast(`Session "${name}" created. Tunggu beberapa detik lalu klik QR.`);
        loadSessions();
      } catch (err) {
        toast(err.message, true);
      } finally {
        ev.target.disabled = false;
      }
    });

    document.getElementById('logout').addEventListener('click', async (ev) => {
      ev.preventDefault();
      try { await api('/api/auth/logout', 'POST'); } catch {}
      location.href = '/admin/login.html';
    });

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    loadMe();
    loadSessions();
    listTimer = setInterval(loadSessions, 5000);
  </script>
</body>
</html>
```

- [ ] **Step 26.3: Mount static dir in `backend/index.js`**

In `backend/index.js`, add after middleware (e.g., after `cookieParser()` and before route mounts):

```javascript
const path = require('path');
app.use('/admin', express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));
```

Add a redirect convenience at the root for ops:

```javascript
app.get('/admin', (_req, res) => res.redirect('/admin/waha-sessions.html'));
```

- [ ] **Step 26.4: Write failing static-serve test `backend/__tests__/staticAdmin.test.js`**

```javascript
process.env.DISABLE_WORKER = 'true';
const request = require('supertest');
const { app } = require('../index');

afterAll(async () => {
  const pg = require('../db/postgres');
  const mysql = require('../db/mysql');
  await pg.end(); await mysql.end();
});

test('GET /admin/login.html returns the login form', async () => {
  const r = await request(app).get('/admin/login.html');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/html/);
  expect(r.text).toMatch(/Tiara Admin Login/);
});

test('GET /admin/waha-sessions.html returns the sessions UI', async () => {
  const r = await request(app).get('/admin/waha-sessions.html');
  expect(r.status).toBe(200);
  expect(r.text).toMatch(/WAHA Sessions/);
});

test('GET /admin redirects to waha-sessions.html', async () => {
  const r = await request(app).get('/admin');
  expect(r.status).toBe(302);
  expect(r.headers.location).toBe('/admin/waha-sessions.html');
});
```

- [ ] **Step 26.5: Run test to verify PASS**

```bash
cd /home/krttpt/crm/backend && npm test -- staticAdmin
```

Expected: 3 tests pass.

- [ ] **Step 26.6: Add Caddy rule for `/admin/*` (update `docs/deployment.md` Caddy block)**

Update the Caddy snippet in `docs/deployment.md` to include `/admin/*` and `/api/admin/*` (which is already covered by `/api/*` block but make it explicit):

```
salesai.prestisa.net {
    encode gzip
    handle /api/* { reverse_proxy 127.0.0.1:3009 }
    handle /webhook/* { reverse_proxy 127.0.0.1:3009 }
    handle /admin/* { reverse_proxy 127.0.0.1:3009 }
    handle /socket.io/* { reverse_proxy 127.0.0.1:3009 }
    handle { respond "Tiara backend is up. Frontend coming." 200 }
}
```

- [ ] **Step 26.7: Manual smoke (live)**

1. Reload Caddy: `! sudo caddy reload --config /etc/caddy/Caddyfile`
2. Visit `https://salesai.prestisa.net/admin/login.html` (or `http://localhost:3009/admin/login.html` if not yet behind Caddy)
3. Login with the admin user seeded in Task 6 (`finance` / `Bunga123` by default — change in production)
4. Click "Create + Start" with a test session name (e.g., `tiara-pilot`)
5. Wait ~5s for status to flip to `SCAN_QR_CODE`, then click "QR"
6. Scan with WhatsApp on your phone — status should flip to `WORKING` within ~10s

- [ ] **Step 26.8: Commit**

```bash
cd /home/krttpt/crm
git add backend/public/login.html backend/public/waha-sessions.html backend/index.js \
        backend/__tests__/staticAdmin.test.js docs/deployment.md
git commit -m "feat(admin-ui): add standalone HTML for WAHA session mgmt (login + sessions + QR)"
```

---

## Updated spec coverage

Tasks 25-26 are **beyond the original spec** but justified by operational necessity: without a way to provision the pilot WAHA session, the rest of the system cannot start receiving messages. Plan B's Next.js frontend will eventually replace `backend/public/waha-sessions.html` — until then this is the live tool.

Two new spec lines effectively added:
- **§13 Deployment:** "Provision pilot WAHA session via UI before first message" (Tasks 25, 26)
- **§15 Open Q1 (WAHA stability):** mitigated — operators can hot-swap sessions without SSH (Tasks 25, 26)

