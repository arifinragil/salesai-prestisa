import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import pageGuides from '@/data/pageGuides';

/**
 * Tooltip — simple hover tooltip using CSS.
 * Usage: <Tooltip text="Keterangan"><span>?</span></Tooltip>
 */
export function Tooltip({ text, children, className = '' }) {
  return (
    <span className={`relative group inline-flex items-center ${className}`}>
      {children}
      {text && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-xs
            rounded-md bg-slate-800 text-white text-xs px-2.5 py-1.5 shadow-lg
            opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50
            whitespace-pre-wrap text-center"
        >
          {text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
        </span>
      )}
    </span>
  );
}

/**
 * PageGuide — floating "?" button (bottom-right, fixed).
 * Reads current route, looks up pageGuides, shows a slide-over panel.
 * Renders nothing if no guide exists for the route (shows generic message instead).
 */
export default function PageGuide() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  // Normalise pathname: strip trailing slash, strip dynamic segments like /inbox/[id]
  const pathname = router.pathname.replace(/\/$/, '');
  const guide = pageGuides[pathname] || null;

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onPointer(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        // Check the button itself is not the target (toggle)
        const btn = document.getElementById('page-guide-btn');
        if (btn && btn.contains(e.target)) return;
        setOpen(false);
      }
    }
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // Close panel on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Floating "?" button */}
      <button
        id="page-guide-btn"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Panduan halaman ini"
        title="Panduan halaman ini"
        className={`fixed bottom-20 right-4 md:bottom-6 md:right-5 z-40
          w-9 h-9 rounded-full shadow-md border
          flex items-center justify-center text-sm font-bold
          transition-colors duration-150
          ${open
            ? 'bg-violet-600 text-white border-violet-700'
            : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-violet-600 hover:border-violet-300'
          }`}
      >
        ?
      </button>

      {/* Slide-over panel */}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Panduan halaman"
          className="fixed bottom-32 right-4 md:bottom-20 md:right-5 z-40
            w-80 max-w-[calc(100vw-2rem)]
            bg-white rounded-xl shadow-2xl border border-slate-200
            overflow-hidden"
        >
          {/* Header */}
          <div className="bg-violet-600 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-white text-base leading-none">📖</span>
              <span className="text-white font-semibold text-sm truncate">
                {guide ? guide.title : 'Panduan'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Tutup panduan"
              className="text-white/80 hover:text-white text-lg leading-none ml-2 shrink-0"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="px-4 py-3 max-h-[60vh] overflow-y-auto text-sm text-slate-700">
            {guide ? (
              <>
                <p className="mb-3 text-slate-600 leading-relaxed">{guide.summary}</p>
                {guide.tips && guide.tips.length > 0 && (
                  <>
                    <p className="font-semibold text-slate-800 mb-1.5">Cara pakai</p>
                    <ul className="space-y-1.5">
                      {guide.tips.map((tip, i) => (
                        <li key={i} className="flex gap-2 leading-snug">
                          <span className="text-violet-500 mt-0.5 shrink-0">•</span>
                          <span>{tip}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {guide.actions && guide.actions.length > 0 && (
                  <>
                    <p className="font-semibold text-slate-800 mt-3 mb-1.5">Aksi cepat</p>
                    <ul className="space-y-1">
                      {guide.actions.map((action, i) => (
                        <li key={i} className="flex gap-2 leading-snug">
                          <span className="text-amber-500 mt-0.5 shrink-0">→</span>
                          <span>{action}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="text-slate-500 italic">Halaman ini belum ada panduan.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
