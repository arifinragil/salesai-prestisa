import { formatTimestamp } from '@/lib/format';

const SENDER_LABEL = {
  customer: 'Customer',
  ai: 'Tiara (AI)',
  staff: 'Operator',
};

export default function MessageBubble({ message }) {
  const isInbound = message.direction === 'in';
  const meta = message.ai_metadata || null;

  return (
    <div className={`flex ${isInbound ? 'justify-start' : 'justify-end'} mb-3`}>
      <div className="max-w-[75%]">
        <div
          className={`rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words ${
            isInbound
              ? 'bg-white border border-slate-200 text-slate-800 rounded-tl-sm'
              : message.sender_type === 'staff'
              ? 'bg-blue-500 text-white rounded-tr-sm'
              : 'bg-brand-500 text-white rounded-tr-sm'
          }`}
        >
          {message.body || (
            <span className="opacity-60 italic">[{message.message_type || 'attachment'}]</span>
          )}
          {message.attachment_url && (
            <div className="mt-2">
              <a
                href={message.attachment_url}
                target="_blank"
                rel="noreferrer"
                className="underline text-xs opacity-90"
              >
                Attachment
              </a>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 px-1 text-xs text-slate-400">
          <span>{SENDER_LABEL[message.sender_type] || message.sender_type}</span>
          <span>·</span>
          <span>{formatTimestamp(message.created_at)}</span>
          {message.shadow && (
            <span className="status-pill status-shadow">shadow</span>
          )}
          {message.send_status === 'send_failed' && (
            <span className="status-pill status-handover">send failed</span>
          )}
          {meta && (
            <span
              className="text-slate-400 cursor-help"
              title={JSON.stringify(meta, null, 2)}
            >
              ℹ
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
