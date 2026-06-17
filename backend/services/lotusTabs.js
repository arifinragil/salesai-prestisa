// backend/services/lotusTabs.js
// Logika murni Kanban Inbox: tentukan tab mana saja yang dicocoki satu lead item.
// Tidak menyentuh DB. Dipanggil HANYA untuk lead status='active' (status difilter di route).

const THRESHOLDS = {
  URGENT_MIN: 30,             // customer nunggu > 30 mnt → urgent
  TUNGGU_BALAS_MAX_MIN: 48 * 60,
  TUNGGU_CUST_MIN_MIN: 60,    // customer diam >= 1 jam
  TUNGGU_CUST_MAX_MIN: 24 * 60,
  CLOSING_SCORE: 60,
};

const CLOSING_INTENTS = new Set(['order_intent', 'order', 'payment', 'closing', 'checkout']);

const WIB_OFFSET_MS = 7 * 3600 * 1000;

function asDate(v) { return v instanceof Date ? v : new Date(v); }
function isInbound(v) { return /^in/i.test(String(v || '')); }
function minutesSince(now, ts) { return (asDate(now).getTime() - asDate(ts).getTime()) / 60000; }

function startOfTodayWIB(now) {
  const wibMs = asDate(now).getTime() + WIB_OFFSET_MS;
  const d = new Date(wibMs);
  const midnightWibAsUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(midnightWibAsUtc - WIB_OFFSET_MS);
}

function tabsForItem(item, now) {
  const tabs = [];
  const inbound = isInbound(item.last_message_from);
  const waiting = item.last_message_at != null ? minutesSince(now, item.last_message_at) : null;
  const snoozed = item.snoozed_until && asDate(item.snoozed_until) > asDate(now);

  if (inbound && waiting != null && waiting > THRESHOLDS.URGENT_MIN && !snoozed) tabs.push('urgent');

  if (/hot/i.test(String(item.lead_temperature || ''))) tabs.push('hot_asap');

  if (item.first_inbound_at && asDate(item.first_inbound_at) >= startOfTodayWIB(now)) tabs.push('customer_baru');

  if (inbound && waiting != null && waiting >= THRESHOLDS.URGENT_MIN
      && waiting <= THRESHOLDS.TUNGGU_BALAS_MAX_MIN && !snoozed) tabs.push('tunggu_balas');

  const score = Number(item.lead_score);
  if ((Number.isFinite(score) && score >= THRESHOLDS.CLOSING_SCORE)
      || CLOSING_INTENTS.has(String(item.last_intent || '').toLowerCase())
      || item.root_cause_tag === 'sudah_closing') tabs.push('mau_closing');

  if (!inbound && waiting != null && waiting >= THRESHOLDS.TUNGGU_CUST_MIN_MIN
      && waiting <= THRESHOLDS.TUNGGU_CUST_MAX_MIN && !snoozed) tabs.push('tunggu_cust');

  return tabs;
}

module.exports = { tabsForItem, startOfTodayWIB, isInbound, THRESHOLDS, CLOSING_INTENTS };
