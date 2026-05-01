import useSWR from 'swr';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { fetcher } from './api';

export function useUser({ redirectTo = null } = {}) {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR('/api/auth/me', fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const user = data?.user || null;
  const unauthenticated = !!error && error.status === 401;

  useEffect(() => {
    if (!isLoading && unauthenticated && redirectTo) {
      const next = encodeURIComponent(router.asPath);
      router.replace(`${redirectTo}?next=${next}`);
    }
  }, [isLoading, unauthenticated, redirectTo, router]);

  return { user, isLoading, unauthenticated, mutate };
}
