import { describe, expect, it } from 'vitest';
import { TAB_TO_STAGES, stageToTab } from '../../../web/src/app/manuscripts/types';

describe('manuscript pipeline tabs', () => {
  it('routes accepted manuscripts to the published tab', () => {
    expect(stageToTab('억셉')).toBe('published');
    expect(TAB_TO_STAGES.published).toContain('억셉');
    expect(TAB_TO_STAGES.submitted).not.toContain('억셉');
  });

  it('keeps each manuscript stage in exactly one tab', () => {
    const stages = ['작성', '심사 중', '대응 중', '억셉', '게재 완료'] as const;

    for (const stage of stages) {
      const matchingTabs = Object.entries(TAB_TO_STAGES)
        .filter(([, tabStages]) => tabStages.includes(stage))
        .map(([tab]) => tab);

      expect(matchingTabs, stage).toHaveLength(1);
      expect(stageToTab(stage), stage).toBe(matchingTabs[0]);
    }
  });
});
