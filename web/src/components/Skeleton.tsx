// ── Skeleton Building Blocks ─────────────────────

/** Animated shimmer bar — YouTube 스타일 wave effect */
function Bone({ className = '', delay = 0 }: { className?: string; delay?: number }) {
  return (
    <div
      className={`rounded animate-shimmer ${className}`}
      style={{
        background: 'linear-gradient(90deg, var(--color-bg-hover) 25%, var(--color-border) 50%, var(--color-bg-hover) 75%)',
        backgroundSize: '200% 100%',
        animationDelay: `${delay}ms`,
      }}
    />
  );
}

/** Card-shaped skeleton with optional children */
function SkeletonCard({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-bg-card rounded-xl border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

// ── Settings Page Skeleton ───────────────────────

export function SettingsSkeleton() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Bone className="h-8 w-32" delay={0} />
        <Bone className="h-4 w-48 mt-2" delay={80} />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-bg-card rounded-lg p-1 border border-border">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="flex-1 py-2 px-3">
            <Bone className="h-5 w-16 mx-auto" delay={150 + i * 60} />
          </div>
        ))}
      </div>

      {/* Status cards grid */}
      <SkeletonCard>
        <Bone className="h-5 w-24 mb-4" delay={400} />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-center gap-3 bg-bg-input rounded-lg p-3">
              <Bone className="w-2.5 h-2.5 rounded-full" delay={480 + i * 80} />
              <div className="flex-1">
                <Bone className="h-3 w-16 mb-1" delay={500 + i * 80} />
                <Bone className="h-3 w-12" delay={520 + i * 80} />
              </div>
            </div>
          ))}
        </div>
      </SkeletonCard>
    </div>
  );
}

// ── Dashboard Page Skeleton ──────────────────────

export function DashboardSkeleton() {
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Bone className="h-8 w-48" delay={0} />
          <Bone className="h-4 w-36 mt-2" delay={80} />
        </div>
        <Bone className="h-7 w-20 rounded-full" delay={120} />
      </div>

      {/* Shortcut cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => (
          <SkeletonCard key={i}>
            <Bone className="w-7 h-7 rounded" delay={200 + i * 100} />
            <Bone className="h-5 w-20 mt-3" delay={240 + i * 100} />
            <Bone className="h-4 w-full mt-2" delay={280 + i * 100} />
          </SkeletonCard>
        ))}
      </div>

      {/* Two-column bottom */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent meetings */}
        <SkeletonCard>
          <div className="flex justify-between mb-4">
            <Bone className="h-5 w-24" delay={600} />
            <Bone className="h-4 w-16" delay={650} />
          </div>
          {[0, 1, 2].map(i => (
            <div key={i} className="p-3 rounded-lg bg-bg-input mb-2">
              <Bone className="h-4 w-3/4" delay={700 + i * 100} />
              <Bone className="h-3 w-full mt-2" delay={740 + i * 100} />
              <Bone className="h-3 w-20 mt-2" delay={780 + i * 100} />
            </div>
          ))}
        </SkeletonCard>

        {/* Cost */}
        <SkeletonCard>
          <div className="flex justify-between mb-4">
            <Bone className="h-5 w-24" delay={650} />
            <Bone className="h-4 w-16" delay={700} />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[0, 1].map(i => (
              <div key={i} className="bg-bg-input rounded-lg p-3">
                <Bone className="h-3 w-10 mb-1" delay={750 + i * 80} />
                <Bone className="h-6 w-16" delay={790 + i * 80} />
              </div>
            ))}
          </div>
          <Bone className="h-3 w-24 mb-2" delay={900} />
          {[0, 1, 2].map(i => (
            <div key={i} className="mb-2">
              <Bone className="h-3 w-full" delay={950 + i * 80} />
              <Bone className="h-1.5 w-full mt-1 rounded-full" delay={990 + i * 80} />
            </div>
          ))}
        </SkeletonCard>
      </div>
    </div>
  );
}

/**
 * Step progress indicator for multi-step operations (e.g. paper crawl)
 */
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
              <span className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-text-heading text-xs flex-shrink-0">✓</span>
            ) : isCurrent ? (
              <div className="w-5 h-5 rounded-full border-2 border-primary flex items-center justify-center flex-shrink-0">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              </div>
            ) : (
              <div className="w-5 h-5 rounded-full border-2 border-border flex-shrink-0" />
            )}
            <span className={`text-sm ${isCurrent ? 'text-text-heading font-medium' : isDone ? 'text-green-400' : 'text-text-muted'}`}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
