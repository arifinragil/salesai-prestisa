// Small formatting helpers shared by inbox + monitor.

export function formatRupiah(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return 'Rp' + num.toLocaleString('id-ID');
}

export function formatRelative(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)}m lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}j lalu`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}h lalu`;
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

export function formatTimestamp(ts) {
  if (!ts) return '';
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function truncate(s, n = 60) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

export function convStatusLabel(conv) {
  if (conv.status === 'closed') return { label: 'closed', cls: 'status-closed' };
  if (conv.status === 'spam')   return { label: 'spam',   cls: 'status-closed' };
  if (conv.open_handovers > 0)  return { label: 'handover', cls: 'status-handover' };
  if (conv.shadow_mode)         return { label: 'shadow', cls: 'status-shadow' };
  if (conv.ai_paused_until && new Date(conv.ai_paused_until) > new Date())
    return { label: 'paused', cls: 'status-paused' };
  return { label: 'AI active', cls: 'status-active' };
}
