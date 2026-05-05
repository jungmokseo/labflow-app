import type { Manuscript } from '@/lib/api';

export type TabKey = 'preparing' | 'submitted' | 'revision' | 'published';

// 단계 → 탭 매핑 (단계 5종을 4 탭에 분배)
export const TAB_TO_STAGES: Record<TabKey, Manuscript['stage'][]> = {
  preparing: ['작성'],
  submitted: ['심사 중', '억셉'],
  revision: ['대응 중'],
  published: ['게재 완료'],
};

export const TAB_LABEL: Record<TabKey, string> = {
  preparing: '준비중',
  submitted: '제출',
  revision: '리비전',
  published: '게재 완료',
};

export const TAB_COLOR: Record<TabKey, string> = {
  preparing: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30',
  submitted: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  revision: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  published: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
};

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

export function timeAgo(iso: string): string {
  const day = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (day === 0) return '오늘';
  if (day === 1) return '어제';
  if (day < 30) return `${day}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export function stageToTab(stage: Manuscript['stage']): TabKey {
  for (const [tab, stages] of Object.entries(TAB_TO_STAGES) as [TabKey, Manuscript['stage'][]][]) {
    if (stages.includes(stage)) return tab;
  }
  return 'preparing';
}
