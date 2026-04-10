/**
 * In-memory rate limiter & cost tracker for AI endpoints
 *
 * Rate limits: 20 requests/minute, 200 requests/day per userId
 * Cost limit: $5/user/day
 *
 * TODO: Replace with Redis for multi-instance deployments.
 * In-memory stores are per-process and will not share state across replicas.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { logError } from '../services/error-logger.js';

// --- Types ---

interface RateEntry {
  minuteCount: number;
  minuteReset: number;
  dayCount: number;
  dayReset: number;
}

interface CostEntry {
  dailyCost: number;
  costBreakdown: Record<string, number>;
  dayReset: number;
}

type AIService =
  | 'gemini-flash'
  | 'claude-sonnet'
  | 'claude-opus'
  | 'openai-embedding'
  | 'openai-realtime'
  | 'openai-whisper';

// --- Constants ---

const MINUTE_LIMIT = 20;
const DAY_LIMIT = 200;
const DAILY_COST_LIMIT = 5.0; // $5/user/day

export const COST_PER_CALL: Record<AIService, number> = {
  'gemini-flash': 0.0001,
  'claude-sonnet': 0.003,       // fallback 고정값 (토큰 기반 계산 우선)
  'claude-opus': 0.05,          // fallback 고정값
  'openai-embedding': 0.00002,
  'openai-realtime': 0.06,   // per minute
  'openai-whisper': 0.006,   // per minute
};

// Anthropic 토큰 기반 실제 단가 (2025-05 기준)
const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet': { input: 3 / 1_000_000, output: 15 / 1_000_000 },  // $3/MTok in, $15/MTok out
  'claude-opus':   { input: 15 / 1_000_000, output: 75 / 1_000_000 }, // $15/MTok in, $75/MTok out
};

/**
 * Anthropic API usage 객체에서 실제 비용 계산
 */
export function calculateAnthropicCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null },
): number {
  const key = model.includes('opus') ? 'claude-opus' : 'claude-sonnet';
  const pricing = ANTHROPIC_PRICING[key];
  if (!pricing) return COST_PER_CALL['claude-sonnet']; // fallback

  const inputCost = usage.input_tokens * pricing.input;
  const outputCost = usage.output_tokens * pricing.output;
  // 캐시 토큰은 할인 적용 (cache read: 10%, cache write: 125%)
  const cacheReadCost = (usage.cache_read_input_tokens || 0) * pricing.input * 0.1;
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) * pricing.input * 1.25;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

const COST_ALERT_THRESHOLDS = [1, 5, 10];

// --- Stores ---

const rateStore = new Map<string, RateEntry>();
const costStore = new Map<string, CostEntry>();

// Track which thresholds have already been logged per user per day
const alertedThresholds = new Map<string, Set<number>>();

// --- Helpers ---

function getRateEntry(userId: string): RateEntry {
  const now = Date.now();
  let entry = rateStore.get(userId);

  if (!entry) {
    entry = {
      minuteCount: 0,
      minuteReset: now + 60_000,
      dayCount: 0,
      dayReset: now + 86_400_000,
    };
    rateStore.set(userId, entry);
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

function getCostEntry(userId: string): CostEntry {
  const now = Date.now();
  let entry = costStore.get(userId);

  if (!entry) {
    entry = {
      dailyCost: 0,
      costBreakdown: {},
      dayReset: now + 86_400_000,
    };
    costStore.set(userId, entry);
  }

  if (now > entry.dayReset) {
    entry.dailyCost = 0;
    entry.costBreakdown = {};
    entry.dayReset = now + 86_400_000;
    alertedThresholds.delete(userId);
  }

  return entry;
}

// --- Rate Limiter Middleware ---

export async function aiRateLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return; // auth middleware will reject

  const rateEntry = getRateEntry(userId);

  if (rateEntry.minuteCount >= MINUTE_LIMIT) {
    return reply.code(429).send({
      error: '요청이 너무 많습니다. 1분 후 다시 시도해주세요.',
      retryAfter: Math.ceil((rateEntry.minuteReset - Date.now()) / 1000),
    });
  }

  if (rateEntry.dayCount >= DAY_LIMIT) {
    return reply.code(429).send({
      error: '일일 사용 한도에 도달했습니다. 내일 다시 시도해주세요.',
      retryAfter: Math.ceil((rateEntry.dayReset - Date.now()) / 1000),
    });
  }

  // Check daily cost limit
  const costEntry = getCostEntry(userId);
  if (costEntry.dailyCost >= DAILY_COST_LIMIT) {
    return reply.code(429).send({
      error: `일일 비용 한도($${DAILY_COST_LIMIT})에 도달했습니다. 내일 다시 시도해주세요.`,
      retryAfter: Math.ceil((costEntry.dayReset - Date.now()) / 1000),
    });
  }

  rateEntry.minuteCount++;
  rateEntry.dayCount++;
}

// --- Cost Tracking ---

export function trackAICost(userId: string, service: string, estimatedCost: number, intent?: string): void {
  const entry = getCostEntry(userId);

  entry.dailyCost += estimatedCost;
  entry.costBreakdown[service] = (entry.costBreakdown[service] ?? 0) + estimatedCost;

  // DB에 영구 저장 (비동기, 실패해도 무시)
  persistCostLog(userId, service, estimatedCost, intent).catch(logError('background', 'AI 비용 로그 저장 실패', { userId, service }, 'warn'));

  // Check alert thresholds
  let userAlerts = alertedThresholds.get(userId);
  if (!userAlerts) {
    userAlerts = new Set();
    alertedThresholds.set(userId, userAlerts);
  }

  for (const threshold of COST_ALERT_THRESHOLDS) {
    if (entry.dailyCost >= threshold && !userAlerts.has(threshold)) {
      userAlerts.add(threshold);
      console.warn(
        `[cost-alert] User ${userId} daily AI cost exceeded $${threshold}: $${entry.dailyCost.toFixed(4)}`,
      );
    }
  }
}

// DB 영구 저장 (lazy import로 순환 의존 방지)
async function persistCostLog(userId: string, service: string, cost: number, intent?: string): Promise<void> {
  const { prisma } = await import('../config/prisma.js');
  await prisma.aiCostLog.create({
    data: { userId, service, cost, intent },
  });
}

// --- Cost Summary ---

export function getCostSummary(userId: string): {
  minuteCount: number;
  dayCount: number;
  dailyCost: number;
  costBreakdown: Record<string, number>;
} {
  const rateEntry = getRateEntry(userId);
  const costEntry = getCostEntry(userId);

  return {
    minuteCount: rateEntry.minuteCount,
    dayCount: rateEntry.dayCount,
    dailyCost: costEntry.dailyCost,
    costBreakdown: { ...costEntry.costBreakdown },
  };
}

// --- Cleanup: remove entries older than 24h, runs every hour ---

setInterval(() => {
  const now = Date.now();

  for (const [userId, entry] of rateStore) {
    if (now > entry.dayReset) rateStore.delete(userId);
  }
  for (const [userId, entry] of costStore) {
    if (now > entry.dayReset) costStore.delete(userId);
  }
  for (const [userId] of alertedThresholds) {
    if (!costStore.has(userId)) alertedThresholds.delete(userId);
  }
}, 3_600_000);
