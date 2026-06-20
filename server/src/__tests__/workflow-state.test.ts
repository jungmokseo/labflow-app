import { describe, expect, it } from 'vitest';
import { countThemePapers } from '../../../web/src/app/papers/state';
import { normalizeCaptureCategory, normalizeCapturePriority } from '../../../web/src/app/tasks/state';

describe('cross-tab workflow state helpers', () => {
  it('normalizes capture category and priority values from the API', () => {
    expect(normalizeCaptureCategory('TASK')).toBe('TASK');
    expect(normalizeCaptureCategory('task')).toBe('TASK');
    expect(normalizeCaptureCategory('IDEA')).toBe('IDEA');
    expect(normalizeCaptureCategory('unknown')).toBe('MEMO');

    expect(normalizeCapturePriority('HIGH')).toBe('HIGH');
    expect(normalizeCapturePriority('medium')).toBe('MEDIUM');
    expect(normalizeCapturePriority(null)).toBe('LOW');
  });

  it('counts paper dashboard core papers from theme buckets without double-counting other papers', () => {
    const themes = new Map<string, Array<{ id: string }>>([
      ['Hydrogel', [{ id: 'p1' }, { id: 'p2' }]],
      ['Liquid Metal', [{ id: 'p3' }]],
    ]);

    expect(countThemePapers(themes)).toBe(3);
  });
});
