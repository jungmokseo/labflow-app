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
