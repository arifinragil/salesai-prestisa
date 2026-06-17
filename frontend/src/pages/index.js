import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useUser } from '@/lib/useUser';

export default function Home() {
  const router = useRouter();
  const { user, isLoading, unauthenticated } = useUser();

  useEffect(() => {
    if (isLoading) return;
    if (user) router.replace('/lotus-inbox');
    else if (unauthenticated) router.replace('/login');
  }, [user, isLoading, unauthenticated, router]);

  return (
    <div className="min-h-screen flex items-center justify-center text-slate-400">
      Redirecting…
    </div>
  );
}
