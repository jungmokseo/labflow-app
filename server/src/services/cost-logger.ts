import { prisma } from '../config/prisma.js';

// Token pricing (per 1M tokens, USD)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':              { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':                { input: 15.00, output: 75.00 },
  'claude-haiku-4-5':               { input: 0.80,  output: 4.00  },
  'gemini-2.5-flash-preview-04-17': { input: 0.075, output: 0.30  },
  'gemini-2.5-flash':               { input: 0.075, output: 0.30  },
  'gemini-2.5-pro-preview-03-25':   { input: 1.25,  output: 10.00 },
  'gemini-2.5-pro':                 { input: 1.25,  output: 10.00 },
};

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  // Normalize model name: strip date suffixes like -20250514, -04-17 etc.
  const normalized = model.replace(/-\d{8}$/, '').replace(/-preview-\d{2}-\d{2}$/, '');
  const price = PRICING[model] ?? PRICING[normalized];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
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

  // Derive service name from model
  let service = 'unknown';
  if (model.startsWith('claude')) {
    service = model.includes('opus') ? 'claude-opus' : model.includes('haiku') ? 'claude-haiku' : 'claude-sonnet';
  } else if (model.startsWith('gemini')) {
    service = model.includes('pro') ? 'gemini-pro' : 'gemini-flash';
  }

  try {
    await prisma.aiCostLog.create({
      data: { userId, service, cost, intent },
    });
  } catch {
    // Cost logging failure should never break the main flow
  }
}
