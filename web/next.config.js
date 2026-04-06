/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
    return [
      {
        // /api/* 요청을 Railway 서버로 프록시 (CORS 우회)
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
      {
        // /health 요청도 프록시
        source: '/health',
        destination: `${apiUrl}/health`,
      },
    ];
  },
};

module.exports = nextConfig;
