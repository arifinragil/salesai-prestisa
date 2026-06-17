// frontend/src/components/lotus-inbox/TabStrip.jsx
const TABS = [
  { key: 'all',           label: 'All',           icon: '',   tone: 'slate' },
  { key: 'urgent',        label: 'Urgent',        icon: '🚨', tone: 'rose' },
  { key: 'hot_asap',      label: 'Hot ASAP',      icon: '🔥', tone: 'orange' },
  { key: 'customer_baru', label: 'Customer Baru', icon: '🆕', tone: 'emerald' },
  { key: 'tunggu_balas',  label: 'Tunggu Balas',  icon: '⏰', tone: 'amber' },
  { key: 'mau_closing',   label: 'Mau Closing',   icon: '✅', tone: 'green' },
  { key: 'tunggu_cust',   label: 'Tunggu Cust',   icon: '🔁', tone: 'sky' },
];

export default function TabStrip({ tab, counts = {}, onChange }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {TABS.map((t) => {
        const active = (tab || 'all') === t.key;
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap border transition
              ${active ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {t.icon && <span>{t.icon}</span>}
            <span className="font-medium">{t.label}</span>
            {typeof n === 'number' && (
              <span className={`ml-0.5 px-1.5 rounded-full text-[11px] ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export { TABS };
