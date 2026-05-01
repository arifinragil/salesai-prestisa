import { useState } from 'react';
import { useRouter } from 'next/router';
import { api, ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      const next = typeof router.query.next === 'string' ? router.query.next : '/inbox';
      router.replace(next);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Login gagal';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white rounded-xl shadow-sm border border-slate-200 p-8"
      >
        <h1 className="text-xl font-semibold text-slate-800 mb-1">Tiara Admin</h1>
        <p className="text-slate-500 text-sm mb-6">Login untuk akses inbox</p>

        <label className="block text-sm text-slate-700 mb-1" htmlFor="u">Username</label>
        <input
          id="u"
          type="text"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm mb-4 focus:outline-none focus:border-brand-500"
        />

        <label className="block text-sm text-slate-700 mb-1" htmlFor="p">Password</label>
        <input
          id="p"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm mb-6 focus:outline-none focus:border-brand-500"
        />

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-brand-500 text-white text-sm font-medium py-2.5 rounded-md hover:bg-brand-600 disabled:opacity-50 transition"
        >
          {submitting ? 'Memproses…' : 'Login'}
        </button>

        {error && (
          <div role="alert" className="mt-4 text-sm text-rose-600">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}
