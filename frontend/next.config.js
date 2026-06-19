/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We deploy behind Caddy on the same origin as the backend (salesai.prestisa.net).
  // No rewrites needed: Caddy proxies /api/* /webhook/* /admin/* /socket.io/* directly
  // to the backend, and everything else hits Next.js.
  poweredByHeader: false,
  async redirects() {
    return [
      { source: '/conversations/:id', destination: '/lotus-inbox/:id', permanent: false },
    ];
  },
};

module.exports = nextConfig;
