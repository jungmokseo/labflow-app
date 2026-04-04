/**
 * Skeleton loading components — 스피너 대신 콘텐츠 형태의 펄스 애니메이션
 */

// 기본 블록
export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-bg-input/40 rounded-lg ${className}`} />;
}

// 텍스트 라인
export function SkeletonLine({ width = 'w-full' }: { width?: string }) {
  return <div className={`animate-pulse bg-bg-input/40 rounded h-3.5 ${width}`} />;
}

// 카드 (회의, 논문, 태스크 등 목록 아이템)
export function SkeletonCard() {
  return (
    <div className="bg-bg-card rounded-xl border border-bg-input/50 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <SkeletonBlock className="w-10 h-10 rounded-full flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <SkeletonLine width="w-3/4" />
          <SkeletonLine width="w-1/2" />
        </div>
      </div>
    </div>
  );
}

// 채팅 메시지 스켈레톤
export function SkeletonMessage({ align = 'left' }: { align?: 'left' | 'right' }) {
  return (
    <div className={`flex ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
      <div className={`space-y-2 ${align === 'right' ? 'max-w-[60%]' : 'max-w-[70%] w-full'}`}>
        <SkeletonBlock className={`h-4 ${align === 'right' ? 'w-48' : 'w-full'} rounded-2xl`} />
        {align === 'left' && <SkeletonBlock className="h-4 w-3/4 rounded-2xl" />}
      </div>
    </div>
  );
}

// 리스트 아이템 스켈레톤
export function SkeletonList({ items = 5 }: { items?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3">
          <SkeletonBlock className="w-8 h-8 rounded-lg flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <SkeletonLine width="w-3/4" />
            <SkeletonLine width="w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// 페이지 전체 스켈레톤 (헤더 + 카드 N개)
export function SkeletonPage({ cards = 4 }: { cards?: number }) {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* 헤더 */}
      <div className="space-y-2">
        <SkeletonLine width="w-48" />
        <SkeletonLine width="w-72" />
      </div>
      {/* 카드 목록 */}
      <div className="space-y-3">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

// 설정/폼 스켈레톤
export function SkeletonForm({ rows = 4 }: { rows?: number }) {
  return (
    <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <SkeletonLine width="w-24" />
          <SkeletonBlock className="w-full h-10" />
        </div>
      ))}
    </div>
  );
}

// 장시간 작업용 단계별 진행 표시
export function StepProgress({
  steps,
  currentStep,
}: {
  steps: string[];
  currentStep: number;
}) {
  return (
    <div className="space-y-2">
      {steps.map((label, i) => {
        const isDone = i < currentStep;
        const isCurrent = i === currentStep;
        return (
          <div key={i} className="flex items-center gap-3">
            {isDone ? (
              <span className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-white text-xs flex-shrink-0">✓</span>
            ) : isCurrent ? (
              <div className="w-5 h-5 rounded-full border-2 border-primary flex items-center justify-center flex-shrink-0">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              </div>
            ) : (
              <div className="w-5 h-5 rounded-full border-2 border-bg-input flex-shrink-0" />
            )}
            <span className={`text-sm ${isCurrent ? 'text-white font-medium' : isDone ? 'text-green-400' : 'text-text-muted'}`}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
