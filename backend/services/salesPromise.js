// backend/services/salesPromise.js
// Detect "sales janji belum balik": a human-sales outbound commitment message
// 3h-48h old with no later human-sales reply. Runs against the lotus messages mirror.

// Bahasa Indonesia promise patterns (from brief).
const PROMISE_RE = /(saya (ajukan|cek|info(rmasikan)?|kabari|tany|cari|coba|tanyakan|proses|kirim)|aku (ajukan|cek|info(rmasikan)?|kabari|tunggu|cari|coba|tanyakan|proses|kirim)|kami (ajukan|cek|info(rmasikan)?|kabari|cari|proses|tanyakan)|ditunggu|tunggu (sebentar|dulu|ya)|akan (saya |kami |kabari|info|cek|hubungi)|nanti (saya |kami |kabari|info|cek|hubungi)|sedang (dicek|diajukan|diproses|dicari|ditanyakan)|mohon (tunggu|nunggu|menunggu)|sabar (ya|dulu)|minta waktu)/i;

function hoursSince(ts, now) {
  if (!ts) return null;
  return Math.round(((now.getTime() - new Date(ts).getTime()) / 3600000) * 10) / 10;
}

function mapPromiseRow(row, now = new Date()) {
  return {
    lotus_id: row.lotus_id,
    cust_name: row.cust_name,
    pic_name: row.assign_to_user_name || null,
    promise_at: row.promise_at,
    promise_body: String(row.promise_body || '').slice(0, 240),
    hours_since_promise: hoursSince(row.promise_at, now),
  };
}

// SQL run against db/lotus. $1 = cust_number array of the in-scope leads. $2 = PROMISE_RE.source.
// Latest human-sales promise per cust_number, 3h-48h ago, no later human-sales reply.
function promiseSql() {
  return `
    WITH promise_msgs AS (
      SELECT m.cust_number, m.id AS msg_id, m.received_at AS promise_at, m.body AS promise_body
      FROM messages m
      WHERE m.direction='outbound' AND m.cs_id IS NOT NULL
        AND m.cust_number = ANY($1::text[])
        AND m.received_at >= now() - interval '48 hours'
        AND m.received_at <  now() - interval '3 hours'
        AND COALESCE(m.body,'') ~* $2
    ),
    latest AS (
      SELECT DISTINCT ON (cust_number) cust_number, msg_id, promise_at, promise_body
      FROM promise_msgs ORDER BY cust_number, promise_at DESC
    )
    SELECT l.cust_number, l.promise_at, l.promise_body
    FROM latest l
    WHERE NOT EXISTS (
      SELECT 1 FROM messages m3
      WHERE m3.cust_number = l.cust_number AND m3.direction='outbound' AND m3.cs_id IS NOT NULL
        AND m3.received_at > l.promise_at
    )
    ORDER BY l.promise_at ASC;`;
}

module.exports = { PROMISE_RE, promiseSql, mapPromiseRow, hoursSince };
