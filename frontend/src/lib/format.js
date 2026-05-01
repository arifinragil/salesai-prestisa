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

export function formatPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  // WhatsApp Linked Identifier — opaque internal ID, not a real phone
  if (s.endsWith('@lid')) {
    const head = s.split('@')[0];
    return `LID:${head.slice(-6)}`;
  }
  // Strip any other JID suffix (@c.us, @s.whatsapp.net)
  const head = s.split('@')[0].replace(/\D/g, '');
  if (!head) return s;
  // Format Indonesian phone: 6281234567890 → +62 812-3456-7890
  if (head.startsWith('62') && head.length >= 11) {
    const rest = head.slice(2);
    const part1 = rest.slice(0, 3);
    const part2 = rest.slice(3, 7);
    const part3 = rest.slice(7);
    return `+62 ${part1}-${part2}${part3 ? '-' + part3 : ''}`;
  }
  return head;
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
