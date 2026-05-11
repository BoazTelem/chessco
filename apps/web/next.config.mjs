/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@chessco/ai',
    '@chessco/analytics',
    '@chessco/chess-core',
    '@chessco/db',
    '@chessco/types',
    '@chessco/ui',
  ],
  typedRoutes: true,
};

export default nextConfig;
