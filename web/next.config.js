/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // lucide-react 50개 아이콘 사용 시 전체 라이브러리가 번들에 포함되는 것을 방지.
  // 실제 사용한 아이콘만 import (tree-shake 강화) — 번들 30~50KB 절감.
  modularizeImports: {
    'lucide-react': {
      transform: 'lucide-react/dist/esm/icons/{{kebabCase member}}',
      preventFullImport: true,
      skipDefaultConversion: true,
    },
  },

  // 큰 패키지의 named import를 자동 tree-shake (Next 14.2+)
  experimental: {
    optimizePackageImports: ['react-markdown', 'lucide-react', '@supabase/ssr', 'remark-gfm', 'remark-breaks'],
  },

  // gzip 압축 (기본 true, 명시)
  compress: true,

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
