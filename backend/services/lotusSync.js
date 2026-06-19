// services/lotusSync.js
// Background worker that mirrors lotus_conversations → crm_conversations /
// crm_messages so all CRM sub-features (pipeline, supervisor, monitor, etc.)
// see Lotus data alongside the existing WAHA pilot data.
//
// Watermarks live in crm_lotus_sync_state:
//   contacts.ingested_at  → max(contacts.ingested_at) we've upserted
//   messages.last_id      → max(messages.id) we've inserted
//
// Idempotent: ON CONFLICT (lotus_id) / (lotus_msg_id) DO NOTHING/UPDATE.
// Batched: CONTACT_BATCH per tick, MSG_BATCH per tick.
// Adaptive: no sleep when batch is full (backfill mode), 30s sleep when idle.

const pg    = require('../db/postgres');
const lotus = require('../db/lotus');
const log   = require('./logger');

const CONTACT_BATCH = parseInt(process.env.LOTUS_SYNC_CONTACT_BATCH) || 1000;
const MSG_BATCH     = parseInt(process.env.LOTUS_SYNC_MSG_BATCH)     || 5000;
const IDLE_SLEEP_MS = parseInt(process.env.LOTUS_SYNC_IDLE_MS)       || 30_000;

async function getState(k) {
  const { rows } = await pg.query(`SELECT v FROM crm_lotus_sync_state WHERE k = $1`, [k]);
  return rows[0]?.v || {};
}
async function setState(k, v) {
  await pg.query(
    `INSERT INTO crm_lotus_sync_state (k, v, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [k, v]
  );
}

function senderTypeOf(direction) {
  return direction === 'inbound' || direction === 'in' ? 'customer' : 'staff';
}
function normalizeDirection(d) {
  if (d === 'inbound') return 'in';
  if (d === 'outbound') return 'out';
  return d || 'in';
}
function normalizeMsgType(t) {
  if (!t) return 'text';
  if (t === 'image' || t === 'document') return t;
  return 'text';
}

// ─── Contacts → crm_conversations ──────────────────────────────────────────
async function syncContacts() {
  const state = await getState('contacts');
  const watermark = state.ingested_at || '1970-01-01T00:00:00Z';

  const { rows: contacts } = await lotus.query(
    `SELECT lotus_id, cust_number, cust_name, business_number, last_message_at,
            first_response_at, ingested_at
     FROM contacts
     WHERE ingested_at > $1
     ORDER BY ingested_at ASC, lotus_id ASC
     LIMIT $2`,
    [watermark, CONTACT_BATCH]
  );

  if (!contacts.length) return { synced: 0, watermark };

  // Bulk upsert
  const cols = 7; // lotus_id, source, phone, real_phone, push_name, last_message_at, first_inbound_at
  const placeholders = contacts.map((_, i) => {
    const o = i * cols;
    return `($${o+1}, 'lotus', $${o+2}, $${o+3}, $${o+4}, $${o+5}, $${o+6}, $${o+7})`;
  }).join(',');
  const params = contacts.flatMap((c) => [
    c.lotus_id,
    (c.cust_number || '').slice(0, 32),
    (c.cust_number || '').slice(0, 32),
    (c.cust_name || '').slice(0, 150) || null,
    c.last_message_at,
    c.last_message_at,  // first_inbound_at: lotus doesn't track first; use last_message_at as a usable default for "has activity"
    c.business_number || null,
  ]);
  // We have 7 placeholders but params have 7 items per contact. Re-do mapping
  // to keep code readable:
  await pg.query(
    `INSERT INTO crm_conversations
       (lotus_id, source, phone, real_phone, push_name, last_message_at, first_inbound_at, wa_session)
     VALUES ${contacts.map((_, i) => `(
       $${i*7+1}, 'lotus',
       $${i*7+2}, $${i*7+3}, $${i*7+4},
       $${i*7+5}, $${i*7+6}, $${i*7+7}
     )`).join(',')}
     ON CONFLICT (lotus_id) WHERE lotus_id IS NOT NULL DO UPDATE
       SET phone           = EXCLUDED.phone,
           real_phone      = EXCLUDED.real_phone,
           push_name       = COALESCE(EXCLUDED.push_name, crm_conversations.push_name),
           last_message_at = GREATEST(crm_conversations.last_message_at, EXCLUDED.last_message_at),
           wa_session      = COALESCE(EXCLUDED.wa_session, crm_conversations.wa_session),
           updated_at      = now()`,
    params
  );

  const newWatermark = contacts[contacts.length - 1].ingested_at;
  await setState('contacts', { ingested_at: newWatermark });
  return { synced: contacts.length, watermark: newWatermark };
}

// ─── Messages → crm_messages ────────────────────────────────────────────────
async function syncMessages() {
  const state = await getState('messages');
  const lastId = state.last_id || 0;

  // Pull next batch, joined to contacts to get the conversation lotus_id
  const { rows: msgs } = await lotus.query(
    `SELECT m.id AS lotus_msg_id, m.cust_number, m.business_number,
            m.direction, m.body, m.message_type, m.received_at,
            m.created_at, m.hsm_name, m.cs_name,
            c.lotus_id AS contact_lotus_id
     FROM messages m
     LEFT JOIN contacts c
       ON c.cust_number = m.cust_number
      AND (c.business_number = m.business_number OR (c.business_number IS NULL AND m.business_number IS NULL))
     WHERE m.id > $1
     ORDER BY m.id ASC
     LIMIT $2`,
    [lastId, MSG_BATCH]
  );

  if (!msgs.length) return { synced: 0, last_id: lastId };

  // Resolve conv_id per contact_lotus_id
  const lotusIds = [...new Set(msgs.map((m) => m.contact_lotus_id).filter(Boolean))];
  let convMap = new Map();
  if (lotusIds.length) {
    const { rows: convs } = await pg.query(
      `SELECT id, lotus_id FROM crm_conversations
       WHERE lotus_id = ANY($1::text[]) AND source = 'lotus'`,
      [lotusIds]
    );
    convMap = new Map(convs.map((r) => [r.lotus_id, r.id]));
  }

  const valid = msgs.filter((m) => m.contact_lotus_id && convMap.has(m.contact_lotus_id));
  if (valid.length) {
    // Build insert in chunks of 1000 to avoid huge param arrays
    const CHUNK = 1000;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const slice = valid.slice(i, i + CHUNK);
      const cols = 8;
      const placeholders = slice.map((_, j) => {
        const o = j * cols;
        return `($${o+1}, $${o+2}, 'lotus', $${o+3}, $${o+4}, $${o+5}, $${o+6}, $${o+7}, $${o+8})`;
      }).join(',');
      const params = slice.flatMap((m) => [
        convMap.get(m.contact_lotus_id),
        m.lotus_msg_id,
        normalizeDirection(m.direction),
        senderTypeOf(m.direction),
        m.body || '',
        normalizeMsgType(m.message_type),
        m.received_at || m.created_at || new Date(),
        m.hsm_name ? JSON.stringify({ hsm_name: m.hsm_name, cs_name: m.cs_name }) : null,
      ]);
      await pg.query(
        `INSERT INTO crm_messages
           (conversation_id, lotus_msg_id, source, direction, sender_type,
            body, message_type, created_at, ai_metadata)
         VALUES ${placeholders}
         ON CONFLICT (lotus_msg_id) WHERE lotus_msg_id IS NOT NULL DO NOTHING`,
        params
      );
    }
  }

  const newLastId = Number(msgs[msgs.length - 1].lotus_msg_id);
  await setState('messages', { last_id: newLastId });
  return { synced: valid.length, skipped: msgs.length - valid.length, last_id: newLastId };
}

// ─── Worker loop ────────────────────────────────────────────────────────────
// Phase 1: drain contacts backlog (CONTACT_BATCH at a time, no sleep).
// Phase 2: once contacts caught up, drain messages.
// Steady state: poll both; contacts upsert first each tick so any new message
// has a target conv when we get to syncMessages().
let stopping = false;
async function runLoop() {
  log.info('[lotusSync] worker started');
  while (!stopping) {
    try {
      const c = await syncContacts();
      // Process messages only when contacts are NOT actively backfilling.
      // During backfill (c.synced is a full batch), skip msgs to avoid
      // losing them to skipped-id watermark advance.
      let m = { synced: 0, skipped: 0, last_id: null };
      if (c.synced < CONTACT_BATCH) {
        m = await syncMessages();
      }
      if (c.synced || m.synced || m.skipped) {
        log.info({ contacts: c.synced, messages: m.synced, skipped: m.skipped, watermark: c.watermark, last_id: m.last_id }, '[lotusSync] tick');
      }
      const fullBatch = c.synced >= CONTACT_BATCH || m.synced >= MSG_BATCH;
      if (!fullBatch) {
        await new Promise((r) => setTimeout(r, IDLE_SLEEP_MS));
      }
    } catch (e) {
      log.error({ err: e.message, stack: e.stack }, '[lotusSync] error');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  log.info('[lotusSync] worker stopped');
}

function stop() { stopping = true; }

module.exports = { runLoop, stop, syncContacts, syncMessages };

// Standalone entrypoint
if (require.main === module) {
  process.on('SIGINT',  () => { log.info({ sig: 'SIGINT'  }, 'shutting down'); stop(); });
  process.on('SIGTERM', () => { log.info({ sig: 'SIGTERM' }, 'shutting down'); stop(); });
  runLoop().catch((e) => {
    log.error({ err: e.message }, '[lotusSync] fatal');
    process.exit(1);
  });
}
