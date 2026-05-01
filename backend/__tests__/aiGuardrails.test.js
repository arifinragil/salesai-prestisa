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
  test('ignores order numbers / tracking IDs (10+ digits)', () => {
    expect(extractPriceMentions('PO 3258042604100976001 sudah jalan')).toEqual([]);
    expect(extractPriceMentions('tracking 1234567890123 telah dikirim')).toEqual([]);
  });
  test('still catches real prices in mixed text', () => {
    expect(extractPriceMentions('PO 3258042604100976001 totalnya Rp 1.443.000')).toEqual(['1443000']);
  });
});

describe('hasHesitation', () => {
  test('detects common hedging phrases', () => {
    expect(hasHesitation('aku kurang yakin Kak')).toBe(true);
    expect(hasHesitation('Saya tidak tahu')).toBe(true);
    expect(hasHesitation('aku tidak yakin Kak')).toBe(true);
    expect(hasHesitation('belum yakin sih')).toBe(true);
    expect(hasHesitation('Maaf, saya tidak bisa pastikan')).toBe(true);
  });
  test('does NOT flag normal Indonesian filler words alone', () => {
    expect(hasHesitation('mungkin pilihan ini cocok')).toBe(false);
    expect(hasHesitation('sepertinya papan sukacita pas')).toBe(false);
    expect(hasHesitation('kayaknya bouquet ini cantik')).toBe(false);
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
