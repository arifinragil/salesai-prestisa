// backend/__tests__/lotusTabs.test.js
const { tabsForItem, THRESHOLDS, CLOSING_INTENTS } = require('../services/lotusTabs');

// now = 2026-06-17T02:00:00Z = 09:00 WIB (17 Juni). Awal hari WIB = 2026-06-16T17:00:00Z.
const NOW = new Date('2026-06-17T02:00:00Z');
const minAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

function item(over = {}) {
  return {
    status: 'active',
    last_message_from: 'inbound',
    last_message_at: minAgo(40),
    first_inbound_at: minAgo(50),
    lead_temperature: 'warm',
    lead_score: 10,
    last_intent: 'tanya_harga',
    root_cause_tag: null,
    snoozed_until: null,
    ...over,
  };
}

describe('urgent', () => {
  test('customer nunggu > 30 mnt → urgent', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(40) }), NOW)).toContain('urgent');
  });
  test('nunggu < 30 mnt → bukan urgent', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(10) }), NOW)).not.toContain('urgent');
  });
  test('snoozed → bukan urgent', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(40), snoozed_until: new Date(NOW.getTime()+3600000).toISOString() }), NOW)).not.toContain('urgent');
  });
  test('last msg dari sales → bukan urgent', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(40) }), NOW)).not.toContain('urgent');
  });
});

describe('hot_asap', () => {
  test("lead_temperature 'hot' → hot_asap", () => {
    expect(tabsForItem(item({ lead_temperature: 'HOT' }), NOW)).toContain('hot_asap');
  });
  test('warm → bukan hot_asap', () => {
    expect(tabsForItem(item({ lead_temperature: 'warm' }), NOW)).not.toContain('hot_asap');
  });
});

describe('customer_baru (WIB)', () => {
  test('first_inbound hari ini WIB → customer_baru', () => {
    expect(tabsForItem(item({ first_inbound_at: '2026-06-17T01:00:00Z' }), NOW)).toContain('customer_baru'); // 08:00 WIB hari ini
  });
  test('first_inbound kemarin WIB → bukan customer_baru', () => {
    expect(tabsForItem(item({ first_inbound_at: '2026-06-16T16:00:00Z' }), NOW)).not.toContain('customer_baru'); // 23:00 WIB kemarin
  });
});

describe('tunggu_balas', () => {
  test('nunggu 40 mnt → tunggu_balas', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(40) }), NOW)).toContain('tunggu_balas');
  });
  test('nunggu 60 jam (>48j) → urgent ya, tunggu_balas tidak', () => {
    const t = tabsForItem(item({ last_message_at: minAgo(60*60) }), NOW);
    expect(t).toContain('urgent');
    expect(t).not.toContain('tunggu_balas');
  });
});

describe('mau_closing', () => {
  test('lead_score >= 60 → mau_closing', () => {
    expect(tabsForItem(item({ lead_score: 75 }), NOW)).toContain('mau_closing');
  });
  test('last_intent closing → mau_closing', () => {
    expect(tabsForItem(item({ last_intent: 'payment' }), NOW)).toContain('mau_closing');
  });
  test("root_cause_tag 'sudah_closing' → mau_closing", () => {
    expect(tabsForItem(item({ root_cause_tag: 'sudah_closing' }), NOW)).toContain('mau_closing');
  });
  test('skor rendah & intent biasa → bukan mau_closing', () => {
    expect(tabsForItem(item({ lead_score: 10, last_intent: 'tanya_harga' }), NOW)).not.toContain('mau_closing');
  });
});

describe('tunggu_cust', () => {
  test('sales balas, customer diam 3 jam → tunggu_cust', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(180) }), NOW)).toContain('tunggu_cust');
  });
  test('diam > 24 jam → bukan tunggu_cust', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(25*60) }), NOW)).not.toContain('tunggu_cust');
  });
  test('diam < 1 jam → bukan tunggu_cust', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(30) }), NOW)).not.toContain('tunggu_cust');
  });
});

test('THRESHOLDS & CLOSING_INTENTS terdefinisi', () => {
  expect(THRESHOLDS.URGENT_MIN).toBe(30);
  expect(THRESHOLDS.TUNGGU_BALAS_MAX_MIN).toBe(48 * 60);
  expect(CLOSING_INTENTS.has('payment')).toBe(true);
});
