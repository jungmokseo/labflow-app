/**
 * Loading components — clean centered spinner (Gemini-style)
 */

// Centered spinner used across all loading states
function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-5 h-5 border-2',
    md: 'w-8 h-8 border-[3px]',
    lg: 'w-10 h-10 border-[3px]',
  };
  return (
    <div className={`${sizeClasses[size]} rounded-full border-border border-t-primary animate-spin`} />
  );
}

// Full-page centered spinner (main one used across pages)
export function SkeletonPage({ cards: _cards = 4 }: { cards?: number }) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Spinner size="lg" />
    </div>
  );
}

// Inline loading block — replaced with small spinner
export function SkeletonBlock({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <Spinner size="sm" />
    </div>
  );
}

// Text line — replaced with small spinner
export function SkeletonLine({ width: _width = 'w-full' }: { width?: string }) {
  return (
    <div className="flex items-center justify-center py-2">
      <Spinner size="sm" />
    </div>
  );
}

// Card spinner
export function SkeletonCard() {
  return (
    <div className="flex items-center justify-center py-6">
      <Spinner size="md" />
    </div>
  );
}

// Chat message spinner
export function SkeletonMessage({ align: _align = 'left' }: { align?: 'left' | 'right' }) {
  return (
    <div className="flex items-center justify-center py-4">
      <Spinner size="sm" />
    </div>
  );
}

// List spinner
export function SkeletonList({ items: _items = 5 }: { items?: number }) {
  return (
    <div className="flex items-center justify-center py-8">
      <Spinner size="md" />
    </div>
  );
}

// Form spinner
export function SkeletonForm({ rows: _rows = 4 }: { rows?: number }) {
  return (
    <div className="flex items-center justify-center py-8">
      <Spinner size="md" />
    </div>
  );
}

// 장시간 작업용 단계별 진행 표시 (kept as-is)
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
