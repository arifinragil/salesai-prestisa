import { useEffect, useState, useCallback, createContext, useContext } from 'react';

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, opts = {}) => {
    setToast({ msg, kind: opts.kind || 'info', id: Date.now() });
  }, []);
  const value = {
    show,
    info: (m) => show(m, { kind: 'info' }),
    success: (m) => show(m, { kind: 'success' }),
    error: (m) => show(m, { kind: 'error' }),
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const color =
    toast?.kind === 'error' ? 'bg-rose-600' :
    toast?.kind === 'success' ? 'bg-emerald-600' :
    'bg-slate-800';

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 ${color} text-white text-sm px-4 py-2 rounded-md shadow-lg z-50 max-w-md`}
          role="status"
        >
          {toast.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
