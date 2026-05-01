import { useEffect, useRef, useState } from 'react';

const PERM_KEY = 'tiara_notif_perm';

export function useNotifPermission() {
  const [state, setState] = useState(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });

  async function request() {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    try {
      const r = await Notification.requestPermission();
      setState(r);
      try { localStorage.setItem(PERM_KEY, r); } catch {}
      return r;
    } catch {
      return 'denied';
    }
  }

  return { state, request, supported: state !== 'unsupported' };
}

// Plays a short beep without bundling audio assets
export function useNotificationSound() {
  const ctxRef = useRef(null);

  useEffect(() => {
    return () => {
      try { ctxRef.current?.close?.(); } catch {}
    };
  }, []);

  return function play({ frequency = 880, duration = 0.18, type = 'sine' } = {}) {
    if (typeof window === 'undefined') return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!ctxRef.current) ctxRef.current = new Ctx();
      const ctx = ctxRef.current;
      // Resume if browser suspended it (autoplay policy)
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      // Quick attack + decay so it feels like a notification chime, not a beep
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration + 0.05);
    } catch {}
  };
}

export function showBrowserNotification({ title, body, tag, onClick }) {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  if (Notification.permission !== 'granted') return null;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    // Don't bother if user is already looking at the page
    return null;
  }
  try {
    const n = new Notification(title, {
      body, tag,
      icon: '/admin/favicon.png', // best-effort; falls back to default if 404
      silent: false,
    });
    if (onClick) n.onclick = () => { try { window.focus(); onClick(); } catch {} n.close(); };
    return n;
  } catch {
    return null;
  }
}
