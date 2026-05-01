import { formatRupiah, formatRelative, truncate, convStatusLabel } from '@/lib/format';

describe('formatRupiah', () => {
  test('formats integer', () => expect(formatRupiah(750000)).toMatch(/750/));
  test('null returns dash', () => expect(formatRupiah(null)).toBe('—'));
  test('handles string number', () => expect(formatRupiah('500000')).toMatch(/500/));
});

describe('truncate', () => {
  test('short string unchanged', () => expect(truncate('halo', 10)).toBe('halo'));
  test('long string truncated', () => expect(truncate('a'.repeat(100), 10)).toBe('aaaaaaaaaa…'));
  test('null returns empty', () => expect(truncate(null)).toBe(''));
});

describe('formatRelative', () => {
  test('seconds ago = "baru saja"', () => {
    const now = new Date();
    expect(formatRelative(now)).toBe('baru saja');
  });
  test('minutes ago', () => {
    const d = new Date(Date.now() - 5 * 60_000);
    expect(formatRelative(d)).toMatch(/5m/);
  });
  test('hours ago', () => {
    const d = new Date(Date.now() - 3 * 3600_000);
    expect(formatRelative(d)).toMatch(/3j/);
  });
  test('null = dash', () => expect(formatRelative(null)).toBe('—'));
});

describe('convStatusLabel', () => {
  test('closed → closed pill', () => {
    expect(convStatusLabel({ status: 'closed' }).label).toBe('closed');
  });
  test('open handover wins over paused/shadow', () => {
    expect(convStatusLabel({ status: 'active', open_handovers: 2, shadow_mode: true }).label).toBe('handover');
  });
  test('shadow without handover', () => {
    expect(convStatusLabel({ status: 'active', shadow_mode: true }).label).toBe('shadow');
  });
  test('paused future', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(convStatusLabel({ status: 'active', ai_paused_until: future }).label).toBe('paused');
  });
  test('paused past = active', () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    expect(convStatusLabel({ status: 'active', ai_paused_until: past }).label).toBe('AI active');
  });
  test('default active', () => {
    expect(convStatusLabel({ status: 'active' }).label).toBe('AI active');
  });
});
