import { prisma } from '../config/prisma.js';

// Token pricing (per 1M tokens, USD) — 2026-05 기준
// 모델 ID 변경 시 cost-logger.ts + automations.ts test-models 둘 다 갱신.
const PRICING: Record<string, { input: number; output: number }> = {
  // ── Anthropic (2026-05) ──
  'claude-sonnet-4-6':              { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':                { input: 5.00,  output: 25.00 },  // 4의 1/3 가격, 1M context 기본
  'claude-opus-4-6':                { input: 15.00, output: 75.00 }, // legacy — 옛 데이터 호환
  'claude-haiku-4-5':               { input: 0.80,  output: 4.00  },
  // ── Google Gemini (2026-05) ──
  'gemini-3.1-flash-lite':                  { input: 0.075, output: 0.30  },
  'gemini-3.1-flash-lite-preview-04-17':    { input: 0.075, output: 0.30  }, // legacy
  'gemini-3.1-flash-lite-preview':          { input: 0.075, output: 0.30  }, // legacy
  'gemini-3.1-pro-preview':                 { input: 1.25,  output: 10.00 },
  'gemini-3.1-pro-preview-customtools':     { input: 1.25,  output: 10.00 },
  'gemini-2.5-pro-preview-03-25':           { input: 1.25,  output: 10.00 }, // legacy
  'gemini-2.5-pro':                         { input: 1.25,  output: 10.00 }, // legacy
  // ── OpenAI (2026-05) ──
  // gpt-realtime-2: text token만 측정 (audio 별도). voice-chatbot에 logApiCost 호출 추가 필요.
  'gpt-realtime-2':                 { input: 5.00,  output: 20.00 },
  'text-embedding-3-small':         { input: 0.02,  output: 0.00  }, // embedding은 input only
};

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  // Normalize model name: strip date suffixes like -20250514, -04-17 etc.
  const normalized = model.replace(/-\d{8}$/, '').replace(/-preview-\d{2}-\d{2}$/, '');
  const price = PRICING[model] ?? PRICING[normalized];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * 모델 ID → service 이름 매핑 (AiCostLog.service 컬럼).
 * 대시보드 집계 시 이 service 단위로 group by.
 *
 * service 종류:
 * - claude-opus, claude-sonnet, claude-haiku
 * - gemini-pro, gemini-flash
 * - openai-realtime, openai-embedding
 * - unknown (PRICING 미등록 모델)
 */
export function deriveService(model: string): string {
  if (model.startsWith('claude')) {
    if (model.includes('opus')) return 'claude-opus';
    if (model.includes('haiku')) return 'claude-haiku';
    return 'claude-sonnet';
  }
  if (model.startsWith('gemini')) {
    return model.includes('pro') ? 'gemini-pro' : 'gemini-flash';
  }
  if (model.startsWith('gpt-realtime') || model.startsWith('gpt-4o-realtime')) {
    return 'openai-realtime';
  }
  if (model.startsWith('text-embedding')) {
    return 'openai-embedding';
  }
  return 'unknown';
}

export async function logApiCost(
  userId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  intent: string,
): Promise<void> {
  const cost = calcCost(model, inputTokens, outputTokens);
  if (cost <= 0) return;

  const service = deriveService(model);

  try {
    await prisma.aiCostLog.create({
      data: { userId, service, cost, intent },
    });
  } catch {
    // Cost logging failure should never break the main flow
  }
}
