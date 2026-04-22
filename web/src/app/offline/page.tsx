import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Offline — Research Flow',
};

// 정적으로 생성되어 SW가 precache 가능하도록
export const dynamic = 'force-static';
export const revalidate = false;

export default function OfflinePage() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center p-6 text-center">
      <div className="max-w-md">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-amber-600 dark:text-amber-400"
          >
            <path d="M1 1l22 22" />
            <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
            <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0122.58 9" />
            <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
            <path d="M8.53 16.11a6 6 0 016.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold mb-2 text-text-main">오프라인 상태</h1>
        <p className="text-sm text-text-muted mb-6 leading-relaxed">
          네트워크 연결이 끊어졌습니다.
          <br />
          이전에 열어본 페이지와 데이터는 그대로 조회할 수 있어요.
          <br />
          입력한 내용은 기기에 저장되어, 온라인 복귀 시 자동으로 동기화됩니다.
        </p>
        <div className="flex gap-2 justify-center">
          <a
            href="/"
            className="px-4 py-2 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1d4ed8]"
          >
            홈으로
          </a>
          <a
            href="/tasks"
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-bg-card"
          >
            할 일 보기
          </a>
        </div>
      </div>
    </div>
  );
}
