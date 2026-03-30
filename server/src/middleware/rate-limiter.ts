/**
 * Simple in-memory rate limiter for AI endpoints
 *
 * Limits: 20 requests/minute, 200 requests/day per userId
 * For 5-user pilot. Replace with Redis-backed limiter for scale.
 */

import { FastifyRequest, FastifyReply } from 'fastify';

interface RateEntry {
  minuteCount: number;
  minuteReset: number;
  dayCount: number;
  dayReset: number;
}

const store = new Map<string, RateEntry>();

const MINUTE_LIMIT = 20;
const DAY_LIMIT = 200;

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

  // Reset windows
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

export async function aiRateLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return; // auth middleware will reject

  const entry = getEntry(userId);

  if (entry.minuteCount >= MINUTE_LIMIT) {
    return reply.code(429).send({
      error: '요청이 너무 많습니다. 1분 후 다시 시도해주세요.',
      retryAfter: Math.ceil((entry.minuteReset - Date.now()) / 1000),
    });
  }

  if (entry.dayCount >= DAY_LIMIT) {
    return reply.code(429).send({
      error: '일일 사용 한도에 도달했습니다. 내일 다시 시도해주세요.',
      retryAfter: Math.ceil((entry.dayReset - Date.now()) / 1000),
    });
  }

  entry.minuteCount++;
  entry.dayCount++;
}
