export type CaptureCategoryKey = 'TASK' | 'IDEA' | 'MEMO';
export type CapturePriorityKey = 'HIGH' | 'MEDIUM' | 'LOW';

export function normalizeCaptureCategory(category: string | null | undefined): CaptureCategoryKey {
  const normalized = (category || '').toUpperCase();
  if (normalized === 'TASK' || normalized === 'IDEA' || normalized === 'MEMO') return normalized;
  return 'MEMO';
}

export function normalizeCapturePriority(priority: string | null | undefined): CapturePriorityKey {
  const normalized = (priority || '').toUpperCase();
  if (normalized === 'HIGH' || normalized === 'MEDIUM' || normalized === 'LOW') return normalized;
  return 'LOW';
}
