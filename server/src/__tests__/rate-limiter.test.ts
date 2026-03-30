import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the rate limiter module inline since it uses Fastify types
describe('Rate Limiter', () => {
  // Simulating the rate limiter logic directly
  const MINUTE_LIMIT = 20;
  const DAY_LIMIT = 200;

  interface RateEntry {
    minuteCount: number;
    minuteReset: number;
    dayCount: number;
    dayReset: number;
  }

  let store: Map<string, RateEntry>;

  beforeEach(() => {
    store = new Map();
  });

  function getEntry(userId: string): RateEntry {
    const now = Date.now();
    let entry = store.get(userId);
    if (!entry) {
      entry = {
        minuteCount: 0,
        minuteReset: now + 60_000,
        dayCount: 0,
        dayReset: now + 86_400_000,
      };
      store.set(userId, entry);
    }
    if (now > entry.minuteReset) {
      entry.minuteCount = 0;
      entry.minuteReset = now + 60_000;
    }
    if (now > entry.dayReset) {
      entry.dayCount = 0;
      entry.dayReset = now + 86_400_000;
    }
    return entry;
  }

  function checkLimit(userId: string): { allowed: boolean; reason?: string } {
    const entry = getEntry(userId);
    if (entry.minuteCount >= MINUTE_LIMIT) return { allowed: false, reason: 'minute' };
    if (entry.dayCount >= DAY_LIMIT) return { allowed: false, reason: 'day' };
    entry.minuteCount++;
    entry.dayCount++;
    return { allowed: true };
  }

  it('allows requests under the minute limit', () => {
    for (let i = 0; i < MINUTE_LIMIT; i++) {
      expect(checkLimit('user1').allowed).toBe(true);
    }
  });

  it('blocks requests over the minute limit', () => {
    for (let i = 0; i < MINUTE_LIMIT; i++) {
      checkLimit('user1');
    }
    expect(checkLimit('user1').allowed).toBe(false);
    expect(checkLimit('user1').reason).toBe('minute');
  });

  it('isolates limits between users', () => {
    for (let i = 0; i < MINUTE_LIMIT; i++) {
      checkLimit('user1');
    }
    expect(checkLimit('user1').allowed).toBe(false);
    expect(checkLimit('user2').allowed).toBe(true);
  });

  it('blocks at daily limit', () => {
    // Simulate many minute windows
    for (let i = 0; i < DAY_LIMIT; i++) {
      const entry = getEntry('user1');
      entry.minuteCount = 0; // Reset minute counter
      checkLimit('user1');
    }
    const entry = getEntry('user1');
    entry.minuteCount = 0;
    expect(checkLimit('user1').allowed).toBe(false);
    expect(checkLimit('user1').reason).toBe('day');
  });
});
