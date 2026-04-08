// ── Skeleton Building Blocks ─────────────────────

/** Animated shimmer bar — YouTube 스타일 콘텐츠 placeholder */
function Bone({ className = '' }: { className?: string }) {
  return <div className={`bg-bg-hover/60 rounded animate-pulse ${className}`} />;
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
        <Bone className="h-8 w-32" />
        <Bone className="h-4 w-48 mt-2" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-bg-card rounded-lg p-1 border border-border">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="flex-1 py-2 px-3">
            <Bone className={`h-5 mx-auto ${i === 1 ? 'w-20 bg-primary/30' : 'w-16'}`} />
          </div>
        ))}
      </div>

      {/* Status cards grid */}
      <SkeletonCard>
        <Bone className="h-5 w-24 mb-4" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex items-center gap-3 bg-bg-input rounded-lg p-3">
              <Bone className="w-2.5 h-2.5 rounded-full" />
              <div className="flex-1">
                <Bone className="h-3 w-16 mb-1" />
                <Bone className="h-3 w-12" />
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
          <Bone className="h-8 w-48" />
          <Bone className="h-4 w-36 mt-2" />
        </div>
        <Bone className="h-7 w-20 rounded-full" />
      </div>

      {/* Shortcut cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => (
          <SkeletonCard key={i}>
            <Bone className="w-7 h-7 rounded" />
            <Bone className="h-5 w-20 mt-3" />
            <Bone className="h-4 w-full mt-2" />
          </SkeletonCard>
        ))}
      </div>

      {/* Two-column bottom */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent meetings */}
        <SkeletonCard>
          <div className="flex justify-between mb-4">
            <Bone className="h-5 w-24" />
            <Bone className="h-4 w-16" />
          </div>
          {[1, 2, 3].map(i => (
            <div key={i} className="p-3 rounded-lg bg-bg-input mb-2">
              <Bone className="h-4 w-3/4" />
              <Bone className="h-3 w-full mt-2" />
              <Bone className="h-3 w-20 mt-2" />
            </div>
          ))}
        </SkeletonCard>

        {/* Cost */}
        <SkeletonCard>
          <div className="flex justify-between mb-4">
            <Bone className="h-5 w-24" />
            <Bone className="h-4 w-16" />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[1, 2].map(i => (
              <div key={i} className="bg-bg-input rounded-lg p-3">
                <Bone className="h-3 w-10 mb-1" />
                <Bone className="h-6 w-16" />
              </div>
            ))}
          </div>
          <Bone className="h-3 w-24 mb-2" />
          {[1, 2, 3].map(i => (
            <div key={i} className="mb-2">
              <Bone className="h-3 w-full" />
              <Bone className="h-1.5 w-full mt-1 rounded-full" />
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
