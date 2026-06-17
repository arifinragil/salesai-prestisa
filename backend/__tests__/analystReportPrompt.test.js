const { buildTierAUserPrompt } = require('../services/analystReport');
test('prompt memuat field stuck_group + stuck_issue', () => {
  const p = buildTierAUserPrompt({ transcript: 'x', msgCount: 5, inboundCount: 4 });
  expect(p).toMatch(/stuck_group/);
  expect(p).toMatch(/stuck_issue/);
  expect(p).toMatch(/customer.*sales.*offer.*proses/s);
});
test('corrections disisipkan saat diberikan', () => {
  const p = buildTierAUserPrompt({ transcript: 'x', msgCount: 5, inboundCount: 4, corrections: [{ to: 'harga_terlalu_mahal', reason: 'budget kecil' }] });
  expect(p).toMatch(/KOREKSI SUPERVISOR/i);
  expect(p).toMatch(/harga_terlalu_mahal/);
});
test('tanpa corrections tidak ada blok koreksi', () => {
  const p = buildTierAUserPrompt({ transcript: 'x', msgCount: 5, inboundCount: 4 });
  expect(p).not.toMatch(/KOREKSI SUPERVISOR/i);
});
