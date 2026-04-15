/**
 * 2-Stage 이메일 분류 서비스
 *
 * Stage 1: Gemini Flash — 빠른 배치 라우팅 (최대 50개/호출)
 *   입력: [{subject, from, snippet(200자)}] + UserPreference rules
 *   출력: [{priority, category, needs_detail, reason}]
 *
 * Stage 2: Claude Sonnet — 고정밀 상세 처리
 *   Stage 1에서 priority: "high" 또는 needs_detail: true인 것만
 *   입력: 이메일 전문 + 사용자 컨텍스트
 *   출력: 상세 요약, 액션 아이템, 답장 초안(필요 시), 일정 추출
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import {
  type EmailPreferenceRules,
  buildPreferencePromptSection,
} from './preference-learning.js';
import { logApiCost } from './cost-logger.js';

// ── 타입 정의 ────────────────────────────────────────

export type EmailCategory = 'urgent' | 'action-needed' | 'schedule' | 'info' | 'ads';
export type EmailPriority = 'high' | 'medium' | 'low';

export interface Stage1Input {
  index: number;
  subject: string;
  from: string;
  snippet: string;   // 200자 이내
  toCC?: string;
}

export interface Stage1Result {
  index: number;
  priority: EmailPriority;
  category: EmailCategory;
  needs_detail: boolean;
  reason: string;
  group?: string;
  groupEmoji?: string;
}

export interface Stage2Input {
  index: number;
  subject: string;
  from: string;
  body: string;
  toCC?: string;
}

export interface Stage2Result {
  index: number;
  category: EmailCategory;
  summary: string;
  actionItems: string[];
  draftReply?: string;
  scheduledEvents?: Array<{ title: string; datetime: string }>;
  confidence: number;
  group?: string;
  groupEmoji?: string;
}

// ── 유저 프로필 타입 (email.ts에서 사용하는 것과 동일) ──
export interface UserProfileForClassification {
  classifyByGroup: boolean;
  groups: Array<{ name: string; domains: string[]; emoji: string }>;
  keywords: string[];
  importanceRules: Array<{ condition: string; action: string; description?: string }>;
}

// ── Stage 1: Gemini Flash 배치 라우팅 ────────────────

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const flashModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

function buildStage1Prompt(
  profile: UserProfileForClassification | null,
  preferenceRules: EmailPreferenceRules | null,
): string {
  let groupInstruction = '';
  if (profile?.classifyByGroup && profile.groups.length > 0) {
    const groupList = profile.groups
      .map(g => `- "${g.name}" (${g.emoji}): domains ${g.domains.join(', ')}`)
      .join('\n');
    groupInstruction = `\n\nGroup Classification:\n${groupList}\n- "개인": all others\nAdd "group" and "groupEmoji" fields.`;
  }

  let keywordSection = '';
  if (profile?.keywords && profile.keywords.length > 0) {
    keywordSection = `\nImportant keywords (boost priority): ${profile.keywords.join(', ')}`;
  }

  let ruleSection = '';
  if (profile?.importanceRules && profile.importanceRules.length > 0) {
    const rules = profile.importanceRules
      .map((r, i) => `${i + 1}. ${r.condition} → ${r.action}`)
      .join('\n');
    ruleSection = `\n\nCustom rules:\n${rules}`;
  }

  // 학습된 선호도 주입
  let preferenceSection = '';
  if (preferenceRules) {
    preferenceSection = buildPreferencePromptSection(preferenceRules);
  }

  return `You are an email triage AI. Classify each email quickly.

Categories:
| Category | Description |
|----------|-------------|
| urgent | Deadline within 24h or immediate action needed |
| action-needed | Requires reply, decision, or approval |
| schedule | Contains dates, events, meetings, calendar invites |
| info | Newsletters, notifications, FYI, CC-only |
| ads | Marketing, promotions, discounts |

Priority levels: high, medium, low
- high: urgent + action-needed
- medium: schedule + important info
- low: regular info + ads

needs_detail: true if the email needs full body analysis for accurate classification.
${groupInstruction}${keywordSection}${ruleSection}${preferenceSection}

Respond with ONLY a JSON array. No other text.
[{"index": 0, "priority": "high|medium|low", "category": "...", "needs_detail": true/false, "reason": "brief reason"${profile?.classifyByGroup ? ', "group": "...", "groupEmoji": "..."' : ''}}]`;
}

export async function classifyEmailBatchStage1(
  emails: Stage1Input[],
  profile: UserProfileForClassification | null,
  preferenceRules: EmailPreferenceRules | null,
  userId?: string,
): Promise<Stage1Result[]> {
  if (emails.length === 0) return [];

  const systemPrompt = buildStage1Prompt(profile, preferenceRules);

  const emailTexts = emails
    .map(e => `[${e.index}] From: "${e.from}"\nSubject: "${e.subject}"\nSnippet: "${e.snippet.substring(0, 200)}"`)
    .join('\n\n');

  try {
    const result = await flashModel.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\nClassify these emails:\n\n${emailTexts}` }],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    });

    const s1Usage = result.response.usageMetadata;
    if (s1Usage && userId) logApiCost(userId, 'gemini-2.5-flash', s1Usage.promptTokenCount ?? 0, s1Usage.candidatesTokenCount ?? 0, 'email_classify_stage1').catch(() => {});
    const responseText = result.response.text().trim();
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in Gemini response');

    const parsed = JSON.parse(jsonMatch[0]) as any[];
    const validCategories: EmailCategory[] = ['urgent', 'action-needed', 'schedule', 'info', 'ads'];
    const validPriorities: EmailPriority[] = ['high', 'medium', 'low'];

    return parsed.map((item: any) => ({
      index: Number(item.index),
      priority: validPriorities.includes(item.priority) ? item.priority : 'low',
      category: validCategories.includes(item.category) ? item.category : 'info',
      needs_detail: Boolean(item.needs_detail),
      reason: String(item.reason || ''),
      group: item.group || undefined,
      groupEmoji: item.groupEmoji || undefined,
    }));
  } catch (error) {
    console.warn('[warn] Stage 1 (Gemini Flash) classification failed:', error);
    // Fallback: 모든 이메일을 medium/info로 분류
    return emails.map(e => ({
      index: e.index,
      priority: 'medium' as EmailPriority,
      category: 'info' as EmailCategory,
      needs_detail: false,
      reason: 'classification fallback',
    }));
  }
}

// ── Stage 2: Claude Sonnet 상세 처리 ─────────────────

function buildStage2Prompt(
  profile: UserProfileForClassification | null,
): string {
  let groupNote = '';
  if (profile?.classifyByGroup && profile.groups.length > 0) {
    groupNote = `\nAlso include "group" and "groupEmoji" in each result based on sender domain.`;
  }

  return `You are an expert email analyst. For each email, provide:
1. Refined category (urgent/action-needed/schedule/info/ads)
2. Detailed summary (2-3 sentences)
3. Action items (if any)
4. Draft reply suggestion (only if action-needed or urgent)
5. Scheduled events extraction (date + title, if any)
${groupNote}

Respond with ONLY a JSON array:
[{
  "index": 0,
  "category": "...",
  "summary": "detailed summary",
  "actionItems": ["item1", "item2"],
  "draftReply": "suggested reply text or null",
  "scheduledEvents": [{"title": "...", "datetime": "ISO8601"}] or [],
  "confidence": 0.0-1.0
  ${profile?.classifyByGroup ? ',"group": "...", "groupEmoji": "..."' : ''}
}]`;
}

export async function classifyEmailDetailStage2(
  emails: Stage2Input[],
  profile: UserProfileForClassification | null,
  userId?: string,
): Promise<Stage2Result[]> {
  if (emails.length === 0) return [];

  if (!env.ANTHROPIC_API_KEY) {
    // Sonnet 미설정 시 fallback
    return emails.map(e => ({
      index: e.index,
      category: 'info' as EmailCategory,
      summary: e.subject.substring(0, 100),
      actionItems: [],
      confidence: 0.5,
    }));
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const systemPrompt = buildStage2Prompt(profile);

  const emailTexts = emails
    .map(e => {
      let text = `[${e.index}] From: "${e.from}"\nSubject: "${e.subject}"`;
      if (e.toCC) text += `\nTo/Cc: "${e.toCC}"`;
      text += `\nBody:\n${e.body.substring(0, 1500)}`;
      return text;
    })
    .join('\n\n---\n\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Analyze these emails in detail:\n\n${emailTexts}`,
      }],
    });

    if (userId) logApiCost(userId, 'claude-sonnet-4-20250514', response.usage.input_tokens, response.usage.output_tokens, 'email_classify_stage2').catch(() => {});
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No text in Sonnet response');

    const jsonMatch = textBlock.text.trim().match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');

    const parsed = JSON.parse(jsonMatch[0]) as any[];
    const validCategories: EmailCategory[] = ['urgent', 'action-needed', 'schedule', 'info', 'ads'];

    return parsed.map((item: any) => ({
      index: Number(item.index),
      category: validCategories.includes(item.category) ? item.category : 'info',
      summary: String(item.summary || '').substring(0, 300),
      actionItems: Array.isArray(item.actionItems) ? item.actionItems.map(String) : [],
      draftReply: item.draftReply || undefined,
      scheduledEvents: Array.isArray(item.scheduledEvents) ? item.scheduledEvents : [],
      confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.8)),
      group: item.group || undefined,
      groupEmoji: item.groupEmoji || undefined,
    }));
  } catch (error) {
    console.warn('[warn] Stage 2 (Sonnet) classification failed:', error);
    return emails.map(e => ({
      index: e.index,
      category: 'info' as EmailCategory,
      summary: e.subject.substring(0, 100),
      actionItems: [],
      confidence: 0.5,
    }));
  }
      }
