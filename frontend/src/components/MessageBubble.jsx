import { useState } from 'react';
import { formatTimestamp } from '@/lib/format';
import { api } from '@/lib/api';

const SENDER_LABEL = {
  customer: 'Customer',
  ai: 'Tiara (AI)',
  staff: 'Operator',
};

const IMAGE_TYPES = new Set(['image', 'jpeg', 'jpg', 'png', 'webp', 'gif']);

function isImage(type, url) {
  if (type && IMAGE_TYPES.has(type.toLowerCase())) return true;
  if (url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return true;
  return false;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url, 'https://x');
    return decodeURIComponent(u.pathname.split('/').pop() || 'file');
  } catch {
    return 'file';
  }
}

function FileIcon({ className = 'w-5 h-5' }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <path d="M5 2h6l4 4v12H5V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M11 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

export default function MessageBubble({ message }) {
  const isInbound = message.direction === 'in';
  const meta = message.ai_metadata || null;
  const [imgError, setImgError] = useState(false);
  const [feedback, setFeedback] = useState(message.feedback ?? null);
  const [fbBusy, setFbBusy] = useState(false);

  async function rate(score) {
    setFbBusy(true);
    try {
      const next = feedback === score ? 0 : score;
      await api(`/api/ops/messages/${message.id}/feedback`, { method: 'POST', body: { score: next } });
      setFeedback(next === 0 ? null : next);
    } catch (err) { alert(err.message); }
    finally { setFbBusy(false); }
  }
  const showFeedback = !isInbound && message.sender_type === 'ai';

  const showImage = message.attachment_url
    && isImage(message.message_type, message.attachment_url)
    && !imgError;
  const showFileLink = message.attachment_url && !showImage;

  const bubbleColor = isInbound
    ? 'bg-white border border-slate-200 text-slate-800 rounded-tl-sm'
    : message.sender_type === 'staff'
    ? 'bg-blue-500 text-white rounded-tr-sm'
    : 'bg-brand-500 text-white rounded-tr-sm';

  return (
    <div className={`flex ${isInbound ? 'justify-start' : 'justify-end'} mb-3`}>
      <div className="max-w-[75%]">
        <div className={`rounded-2xl text-sm whitespace-pre-wrap break-words overflow-hidden ${bubbleColor}`}>
          {showImage && (
            <a
              href={message.attachment_url}
              target="_blank"
              rel="noreferrer"
              className="block bg-black/5"
            >
              <img
                src={message.attachment_url}
                alt={message.body || 'image'}
                onError={() => setImgError(true)}
                loading="lazy"
                className="block w-full max-w-xs max-h-80 object-contain"
              />
            </a>
          )}
          {(message.body || showFileLink) && (
            <div className="px-4 py-2">
              {message.body && <span>{message.body}</span>}
              {!message.body && showFileLink && (
                <span className="opacity-60 italic">[{message.message_type || 'attachment'}]</span>
              )}
              {showFileLink && (
                <div className="mt-2">
                  <a
                    href={message.attachment_url}
                    target="_blank"
                    rel="noreferrer"
                    download
                    className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs ${
                      isInbound
                        ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        : 'bg-white/15 text-white hover:bg-white/25'
                    }`}
                  >
                    <FileIcon className="w-4 h-4" />
                    <span className="truncate max-w-[200px]">{filenameFromUrl(message.attachment_url)}</span>
                  </a>
                </div>
              )}
              {imgError && (
                <div className="text-[10px] mt-1 opacity-70">
                  ⚠ image gagal load — klik link di bawah
                </div>
              )}
            </div>
          )}
          {!message.body && !showFileLink && !showImage && (
            <div className="px-4 py-2">
              <span className="opacity-60 italic">[{message.message_type || 'attachment'}]</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 px-1 text-xs text-slate-400">
          <span>
            {message.sender_type === 'staff' && (message.staff_name || message.staff_username)
              ? `${message.staff_name || message.staff_username} (operator)`
              : (SENDER_LABEL[message.sender_type] || message.sender_type)}
          </span>
          <span>·</span>
          <span>{formatTimestamp(message.created_at)}</span>
          {message.shadow && <span className="status-pill status-shadow">shadow</span>}
          {isInbound && message.sentiment && message.sentiment !== 'neutral' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                message.sentiment === 'angry' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                message.sentiment === 'frustrated' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                message.sentiment === 'positive' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                'bg-slate-50 text-slate-600 border-slate-200'
              }`}
              title={`sentiment: ${message.sentiment}`}
            >
              {message.sentiment === 'angry' ? '😡' : message.sentiment === 'frustrated' ? '😤' : message.sentiment === 'positive' ? '😊' : ''} {message.sentiment}
            </span>
          )}
          {isInbound && Array.isArray(message.pii_flags) && message.pii_flags.length > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200"
              title={`PII terdeteksi: ${message.pii_flags.join(', ')}`}
            >🔒 PII</span>
          )}
          {message.send_status === 'send_failed' && (
            <span className="status-pill status-handover">send failed</span>
          )}
          {meta && (
            <span className="text-slate-400 cursor-help" title={JSON.stringify(meta, null, 2)}>ℹ</span>
          )}
          {showFeedback && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button" disabled={fbBusy}
                onClick={() => rate(1)}
                aria-label="Reply ini bagus"
                className={`w-6 h-6 inline-flex items-center justify-center rounded transition ${
                  feedback === 1 ? 'bg-emerald-100 text-emerald-700' : 'text-slate-400 hover:bg-slate-100 hover:text-emerald-600'
                }`}
              >👍</button>
              <button
                type="button" disabled={fbBusy}
                onClick={() => rate(-1)}
                aria-label="Reply ini buruk"
                className={`w-6 h-6 inline-flex items-center justify-center rounded transition ${
                  feedback === -1 ? 'bg-rose-100 text-rose-700' : 'text-slate-400 hover:bg-slate-100 hover:text-rose-600'
                }`}
              >👎</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
