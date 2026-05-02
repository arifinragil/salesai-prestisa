import { useState, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';

// Lightweight mention picker. Wraps a textarea, detects "@<token>",
// shows dropdown, on select inserts "@<username> ".
export default function MentionAutocomplete({ value, onChange, placeholder, rows = 3, className = '' }) {
  const ref = useRef(null);
  const [showDrop, setShowDrop] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const users = useSWR('/api/users/active', fetcher, { dedupingInterval: 60_000 });

  const filtered = (users.data?.items || [])
    .filter((u) => !filter || u.username.toLowerCase().startsWith(filter))
    .slice(0, 8);

  function handleChange(e) {
    const v = e.target.value;
    onChange(v);
    const cursor = e.target.selectionStart;
    // Find the @<token> being typed at cursor
    const before = v.slice(0, cursor);
    const m = before.match(/@([a-zA-Z0-9._-]*)$/);
    if (m) {
      setShowDrop(true);
      setFilter(m[1].toLowerCase());
      setHighlighted(0);
    } else {
      setShowDrop(false);
    }
  }

  function insertMention(username) {
    const ta = ref.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    const before = value.slice(0, cursor).replace(/@[a-zA-Z0-9._-]*$/, `@${username} `);
    const after = value.slice(cursor);
    const next = before + after;
    onChange(next);
    setShowDrop(false);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(before.length, before.length);
    }, 0);
  }

  function handleKeyDown(e) {
    if (!showDrop || !filtered.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMention(filtered[highlighted].username);
    } else if (e.key === 'Escape') {
      setShowDrop(false);
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        className={`w-full px-2 py-1.5 text-sm border border-slate-200 rounded ${className}`}
      />
      {showDrop && filtered.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 z-30 bg-white border border-slate-200 rounded shadow-lg w-64 max-h-60 overflow-y-auto">
          {filtered.map((u, i) => (
            <button
              key={u.id} type="button"
              onMouseDown={(e) => { e.preventDefault(); insertMention(u.username); }}
              className={`w-full text-left px-2 py-1.5 text-xs ${i === highlighted ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-50'}`}
            >
              <div className="font-medium">@{u.username}</div>
              {u.full_name && <div className="text-[10px] text-slate-500">{u.full_name}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
