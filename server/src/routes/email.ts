/**
 * Gmail 이메일 브리핑 API 라우트 — 완전 개인화 버전
 *
 * 모든 분류 규칙이 사용자 프로필(EmailProfile)에서 동적으로 로드됨:
 * - excludePatterns: 제외 패턴 (주간보고, 광고 등 — 사용자가 직접 설정)
 * - keywords: 중요도 상향 키워드 (연구 분야, 프로젝트명 등)
 * - importanceRules: 카테고리 승격/강등 규칙 (도메인, 조건, 액션)
 * - senderTimezones: 발신자 도메인→시간대 매핑 (이중 시간 표기용)
 * - groups: 기관별 그룹 분류 (도메인 매핑)
 * - timezone: 사용자 기본 시간대
 *
 * 하드코딩된 규칙 없음 — 프로필 미설정 시 기본 5분류만 수행.
 *
 * GET    /api/email/auth/url       — Google OAuth 동의 URL
 * GET    /api/email/auth/callback  — OAuth 콜백 처리
 * GET    /api/email/status         — Gmail 연동 상태
 * GET    /api/email/briefing       — 이메일 브리핑 (Sonnet 분류)
 * GET    /api/email/profile        — 프로필 조회
 * PUT    /api/email/profile        — 프로필 저장
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { google } from 'googleapis';
import { createHmac } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { trackAICost, COST_PER_CALL } from '../middleware/rate-limiter.js';
import { buildGraphFromText } from '../services/knowledge-graph.js';
import { classifyEmailBatchStage1, type Stage1Input, type Stage1Result, type UserProfileForClassification } from '../services/email-classifier.js';
import { encryptToken, decryptToken, isEncrypted } from '../utils/crypto.js';

// Safely decrypt a token — handles both encrypted and legacy plaintext values
function safeDecrypt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return isEncrypted(value) ? decryptToken(value) : value;
  } catch {
    return value; // fallback to raw value if decryption fails
  }
}

// ── OAuth state HMAC 서명 ────────────────────────────
const STATE_SECRET = env.SUPABASE_JWT_SECRET || env.TOKEN_ENCRYPTION_KEY || 'labflow-oauth-state-secret';
function signState(userId: string): string {
  const sig = createHmac('sha256', STATE_SECRET).update(userId).digest('hex').slice(0, 16);
  return `${userId}:${sig}`;
}
function verifyState(state: string): string | null {
  const [userId, sig] = state.split(':');
  if (!userId || !sig) return null;
  const expected = createHmac('sha256', STATE_SECRET).update(userId).digest('hex').slice(0, 16);
  if (sig !== expected) return null;
  return userId;
}

// ── Zod 스키마 ──────────────────────────────────────
const briefingQuerySchema = z.object({
  maxResults: z.coerce.number().min(1).max(100).default(30),
  includeSpam: z.enum(['true', 'false']).default('false'),
  since: z.string().optional(),           // ISO datetime (T_last override)
  includeBody: z.enum(['true', 'false']).default('true'), // 본문 열람 활성화
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
});

const emailGroupSchema = z.object({
  name: z.string().min(1).max(50),
  domains: z.array(z.string()),
  emoji: z.string().max(4).default('[mail]'),
});

const importanceRuleSchema = z.object({
  condition: z.string(), // 자연어 조건 (Sonnet 프롬프트에 주입)
  action: z.string(),    // 자연어 액션 (e.g., "urgent로 상향", "ads로 강등")
  description: z.string().optional(),
});

const senderTimezoneSchema = z.object({
  domains: z.array(z.string()), // 도메인 패턴 목록 (e.g., [".kr", "naver.com"])
  timezone: z.string(),          // IANA 시간대 (e.g., "Asia/Seoul")
  label: z.string().optional(),  // 표시 라벨 (e.g., "KST")
});

const profileUpdateSchema = z.object({
  classifyByGroup: z.boolean(),
  groups: z.array(emailGroupSchema),
  excludePatterns: z.array(z.object({
    field: z.enum(['subject', 'from']),
    pattern: z.string(),
  })).optional(),
  keywords: z.array(z.string()).optional(),
  importanceRules: z.array(importanceRuleSchema).optional(),
  senderTimezones: z.array(senderTimezoneSchema).optional(),
  timezone: z.string().optional(),
});

// ── 타입 ──────────────────────────────────────────
interface EmailGroup {
  name: string;
  domains: string[];
  emoji: string;
}

interface ExcludePattern {
  field: 'subject' | 'from';
  pattern: string;
}

interface ImportanceRule {
  condition: string;
  action: string;
  description?: string;
}

interface SenderTimezone {
  domains: string[];
  timezone: string;
  label?: string;
}

interface UserProfile {
  classifyByGroup: boolean;
  groups: EmailGroup[];
  excludePatterns: ExcludePattern[];
  keywords: string[];
  importanceRules: ImportanceRule[];
  senderTimezones: SenderTimezone[];
  timezone: string;
}

type EmailCategory = 'urgent' | 'action-needed' | 'schedule' | 'info' | 'ads';

interface EmailBriefing {
  sender: string;
  senderName: string;
  subject: string;
  snippet: string;
  body?: string;           // 긴급/대응필요만 포함
  date: string;
  dateSender?: string;     // 발신자 시간대 (매칭 시)
  dateSenderLabel?: string; // 발신자 시간대 라벨
  dateLocal: string;       // 사용자 기본 시간대 표기
  category: EmailCategory;
  categoryEmoji: string;
  group?: string;
  groupEmoji?: string;
  summary: string;
  messageId: string;
  threadId?: string;
  matchedTimezone?: string; // 매칭된 발신자 시간대 ID
}

interface EmailClassification {
  category: EmailCategory;
  group?: string;
  groupEmoji?: string;
  confidence: number;
  summary: string;
  needsBody: boolean;
}

// ── 카테고리 라벨 매핑 (고정 — 출력 포맷) ──────────
const CATEGORY_EMOJI: Record<EmailCategory, string> = {
  'urgent': '[긴급]',
  'action-needed': '[대응]',
  'schedule': '[일정]',
  'info': '[정보]',
  'ads': '[광고]',
};

// ── 시간대 유틸 ──────────────────────────────────────
function formatDateWithTimezone(dateMs: number, timezone: string): string {
  try {
    return new Date(dateMs).toLocaleString('ko-KR', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch {
    return new Date(dateMs).toISOString();
  }
}

/**
 * 발신자 주소에 매칭되는 시간대를 프로필에서 찾기.
 * 프로필에 senderTimezones가 없으면 null 반환 (이중 시간 표기 안 함).
 */
function matchSenderTimezone(
  fromAddress: string,
  senderTimezones: SenderTimezone[],
): SenderTimezone | null {
  if (!senderTimezones || senderTimezones.length === 0) return null;
  const addr = fromAddress.toLowerCase();
  return senderTimezones.find(st =>
    st.domains.some(d => addr.includes(d.toLowerCase()))
  ) || null;
}

// ── Gmail 클라이언트 ────────────────────────────────
function createOAuth2Client() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth 자격증명이 설정되지 않았습니다');
  }
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

// ── Anthropic 클라이언트 ────────────────────────────
function createAnthropicClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// ── Sonnet 분류 프롬프트 (완전 동적 — 프로필 기반) ───
function buildClassificationPrompt(profile: UserProfile | null): string {
  // ── 기관별 분류 지침 ──
  let groupInstruction = '';
  if (profile?.classifyByGroup && profile.groups.length > 0) {
    const groupList = profile.groups
      .map(g => `- "${g.name}" (${g.emoji}): 발신자 또는 To/Cc 도메인이 ${g.domains.join(', ')} 중 하나와 일치`)
      .join('\n');
    groupInstruction = `

## 기관별 분류
발신자(From) 주소를 1차 기준으로, 모호한 경우 To/Cc 주소로 판단하여 다음 그룹 중 하나에 배정:
${groupList}
- "개인": 위 그룹에 해당하지 않는 모든 메일

각 이메일의 JSON에 "group"과 "groupEmoji" 필드를 추가하세요.`;
  }

  // ── 중요도 상향 키워드 ──
  let keywordSection = '';
  if (profile?.keywords && profile.keywords.length > 0) {
    keywordSection = `
- **키워드 상향:** 다음 키워드가 제목/내용에 등장하면 중요도 1단계 상향: ${profile.keywords.join(', ')}`;
  }

  // ── 사용자 커스텀 중요도 규칙 ──
  let importanceSection = '';
  if (profile?.importanceRules && profile.importanceRules.length > 0) {
    const rules = profile.importanceRules
      .map((r, i) => `${i + 1}. ${r.condition} → ${r.action}${r.description ? ` (${r.description})` : ''}`)
      .join('\n');
    importanceSection = `

## 사용자 맞춤 중요도 규칙
다음 규칙을 순서대로 적용하세요:
${rules}`;
  }

  return `당신은 이메일을 정밀하게 분류하는 전문 AI 비서입니다.

## 성격별 분류 (5카테고리)

| 카테고리 | 이모지 | 설명 |
|----------|--------|------|
| urgent | [긴급] | 마감 24시간 이내 또는 즉각 조치 필요 |
| action-needed | [대응] | 의견·결정·승인 요청, 명시적 회신 요청 |
| schedule | [일정] | 날짜/시간이 포함된 이벤트, 마감일, 미팅, 캘린더 초대 |
| info | [정보] | 공지, 뉴스레터, 알림, 단순 CC 수신, 처리 완료 보고 |
| ads | [광고] | 마케팅 광고, 프로모션, 할인, 구독 권유 |
${groupInstruction}

## 중요도 조정 규칙
${keywordSection}${importanceSection}

## 본문 열람 판단
각 이메일에 "needsBody" (boolean) 필드를 추가:
- urgent / action-needed → true
- schedule → snippet이 불명확한 경우만 true
- info / ads → false

## 요약 규칙
- [긴급]/[대응]: 핵심 내용 + 조치사항(→) 1줄. 최대 3줄.
- [일정]: 이벤트명 + 날짜/시간.
- [정보]: 발신자 — 한 줄 요약.
- [광고]: 발신자 + 제목만.
- 같은 스레드의 여러 메일은 하나로 합쳐 최신 상태로 요약.

응답에 이모지를 절대 사용하지 마라. 이모지 대신 마크다운 서식으로 구조를 표현하라.`;
}

/** 도메인 매칭으로 기관 찾기 */
function domainMatchGroup(sender: string, profile: UserProfile | null): { name: string; emoji: string } | null {
  if (!profile?.classifyByGroup || !profile.groups?.length) return null;
  const senderLower = sender.toLowerCase();
  for (const g of profile.groups) {
    if (g.domains?.length > 0 && g.domains.some((d: string) => senderLower.includes(d.toLowerCase()))) {
      return { name: g.name, emoji: g.emoji };
    }
  }
  return null;
}

/**
 * Sonnet 없을 때 서사형 브리핑 fallback (텍스트 기반 정리)
 */
function generateFallbackNarrative(emailData: string[], timezone: string): string {
  const today = new Date().toLocaleDateString('ko-KR', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  let md = `# 이메일 브리핑\n\n> ${today} 기준 · 총 ${emailData.length}건\n\n`;
  md += `## 수신 이메일 목록\n\n`;
  for (const email of emailData) {
    md += email + '\n\n';
  }
  md += `\n---\n*AI 분석 비활성화 상태 — Anthropic API 키를 설정하면 서사형 분석이 제공됩니다.*\n`;
  return md;
}

/**
 * 규칙 기반 이메일 분류 (Sonnet 없을 때 fallback)
 * 도메인 매칭 + 키워드 규칙으로 기관/성격 분류
 */
function classifyByRules(
  subject: string,
  sender: string,
  snippet: string,
  profile: UserProfile | null,
): EmailClassification {
  const subjectLower = subject.toLowerCase();
  const senderLower = sender.toLowerCase();
  const text = `${subject} ${snippet}`.toLowerCase();

  // 1. 성격별 분류 (키워드 매칭)
  let category: EmailCategory = 'info';
  if (/긴급|urgent|asap|deadline|마감|즉시/.test(text)) {
    category = 'urgent';
  } else if (/검토|확인.*요청|결재|승인|제출|회신|답변.*바|요청드|부탁드/.test(text)) {
    category = 'action-needed';
  } else if (/일정|미팅|회의|세미나|워크숍|참석|zoom|meet|calendar|초대/.test(text)) {
    category = 'schedule';
  } else if (/no-?reply|noreply|newsletter|unsubscribe|수신거부|광고/.test(senderLower)) {
    category = 'ads';
  }

  // 2. 기관별 분류 (도메인 매칭)
  let group: string | undefined;
  let groupEmoji: string | undefined;
  if (profile?.classifyByGroup && profile.groups?.length > 0) {
    for (const g of profile.groups) {
      if (g.domains?.length > 0 && g.domains.some((d: string) => senderLower.includes(d.toLowerCase()))) {
        group = g.name;
        groupEmoji = g.emoji;
        break;
      }
    }
    if (!group) {
      // 매칭 안 되면 마지막 그룹 (보통 "개인")
      const lastGroup = profile.groups[profile.groups.length - 1];
      group = lastGroup?.name || '개인';
      groupEmoji = lastGroup?.emoji || '[개인]';
    }
  }

  // 3. 요약 생성 (snippet에서 핵심 추출)
  let summary = snippet || subject;
  if (summary.length > 80) summary = summary.slice(0, 77) + '...';

  return {
    category,
    confidence: 0.6,
    summary,
    needsBody: false,
    group,
    groupEmoji,
  };
}

/**
 * Sonnet 기반 이메일 분류
 */
async function classifyEmailsWithSonnet(
  emails: Array<{ index: number; subject: string; snippet: string; sender: string; toCC: string; body?: string }>,
  profile: UserProfile | null,
): Promise<Map<string, EmailClassification>> {
  const results = new Map<string, EmailClassification>();
  const anthropic = createAnthropicClient();

  if (!anthropic) {
    // fallback — Sonnet 미설정 시 규칙 기반 분류
    emails.forEach((e) => {
      const cls = classifyByRules(e.subject, e.sender, e.snippet, profile);
      results.set(String(e.index), cls);
    });
    return results;
  }

  try {
    const emailTexts = emails
      .map(e => {
        let text = `[${e.index}] From: "${e.sender}"\nTo/Cc: "${e.toCC}"\n제목: "${e.subject}"\n스니펫: "${e.snippet}"`;
        if (e.body) {
          text += `\n본문(일부): "${e.body.substring(0, 500)}"`;
        }
        return text;
      })
      .join('\n\n');

    const systemPrompt = buildClassificationPrompt(profile);
    const hasGroups = profile?.classifyByGroup && profile.groups.length > 0;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0.1,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `다음 이메일들을 분류하세요. JSON 배열로만 응답:\n\n${emailTexts}\n\n응답 형식:\n[\n  { "index": 0, "category": "...", "confidence": 0.0~1.0, "summary": "요약"${hasGroups ? ', "group": "...", "groupEmoji": "..."' : ''}, "needsBody": true/false }\n]`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No text in response');

    const jsonMatch = textBlock.text.trim().match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON found');

    const classifications = JSON.parse(jsonMatch[0]);
    classifications.forEach((item: any) => {
      if (typeof item.index === 'number' && item.index >= 0 && item.index < emails.length) {
        results.set(String(item.index), {
          category: validateCategory(item.category),
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.5)),
          summary: String(item.summary || emails[item.index].subject).substring(0, 100),
          group: item.group || undefined,
          groupEmoji: item.groupEmoji || undefined,
          needsBody: Boolean(item.needsBody),
        });
      }
    });
  } catch (error) {
    console.warn('[warn] Sonnet 분류 실패:', error);
    emails.forEach((e) => {
      results.set(String(e.index), {
        category: 'info',
        confidence: 0.5,
        summary: e.subject.substring(0, 50),
        needsBody: false,
      });
    });
  }

  return results;
}

function validateCategory(cat: string): EmailCategory {
  const valid: EmailCategory[] = ['urgent', 'action-needed', 'schedule', 'info', 'ads'];
  return valid.includes(cat as EmailCategory) ? (cat as EmailCategory) : 'info';
}

// ── 제외 필터 (프로필 기반만 — 하드코딩 없음) ────────
function isExcluded(
  subject: string,
  sender: string,
  excludePatterns: ExcludePattern[],
): boolean {
  for (const p of excludePatterns) {
    const target = p.field === 'subject' ? subject : sender;
    if (target.toLowerCase().includes(p.pattern.toLowerCase())) return true;
  }
  return false;
}

// ── Gmail 메시지 본문 추출 ──────────────────────────
function extractBody(payload: any): string {
  if (!payload) return '';

  // 단순 텍스트
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').substring(0, 2000);
  }

  // multipart
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8').substring(0, 2000);
      }
    }
    // fallback: HTML에서 텍스트 추출
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
      }
    }
  }

  return '';
}

// ── 헬퍼: User 확인/생성 ─────────────────────────────
async function ensureUser(clerkId: string) {
  let user = await prisma.user.findFirst({ where: { clerkId } });
  if (!user) {
    user = await prisma.user.create({
      data: { clerkId, email: `${clerkId}@dev.labflow.app`, name: 'Dev User' },
    });
  }
  return user;
}

// ── 프로필 파싱 헬퍼 ──────────────────────────────────
function parseProfile(raw: any): UserProfile {
  return {
    classifyByGroup: raw.classifyByGroup ?? false,
    groups: (raw.groups as EmailGroup[]) ?? [],
    excludePatterns: (raw.excludePatterns as ExcludePattern[]) ?? [],
    keywords: (raw.keywords as string[]) ?? [],
    importanceRules: (raw.importanceRules as ImportanceRule[]) ?? [],
    senderTimezones: (raw.senderTimezones as SenderTimezone[]) ?? [],
    timezone: raw.timezone ?? 'America/New_York',
  };
}

function profileToResponse(profile: UserProfile, lastBriefingAt?: Date | null) {
  return {
    classifyByGroup: profile.classifyByGroup,
    groups: profile.groups,
    excludePatterns: profile.excludePatterns,
    keywords: profile.keywords,
    importanceRules: profile.importanceRules,
    senderTimezones: profile.senderTimezones,
    timezone: profile.timezone,
    lastBriefingAt: lastBriefingAt?.toISOString() || null,
  };
}

// ── OAuth 콜백 (별도 플러그인 — auth 없음) ──────────────
// Fastify addHook은 플러그인 스코프 전체 적용 → 콜백은 반드시 분리
export async function emailCallbackRoute(app: FastifyInstance) {
  app.get('/api/email/auth/callback', async (request, reply) => {
    const query = callbackQuerySchema.parse(request.query);
    // Google 리다이렉트는 custom header 불가 → state 파라미터에서 userId 추출 (HMAC 검증)
    const userId = query.state ? verifyState(query.state) : null;
    if (!userId) {
      return reply.code(400).send({ error: 'Invalid OAuth state — 다시 연동을 시도해주세요.' });
    }
    try {
      const oauth2Client = createOAuth2Client();
      const { tokens } = await oauth2Client.getToken(query.code);
      const user = await ensureUser(userId);

      // Gmail 계정 이메일 주소 조회
      oauth2Client.setCredentials(tokens);
      let gmailAddress = '';
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        gmailAddress = profile.data.emailAddress || '';
      } catch { /* 이메일 주소 조회 실패 시 빈 문자열 */ }

      // 기존 토큰 중 같은 계정이 있으면 업데이트, 없으면 생성
      const existingToken = await prisma.gmailToken.findFirst({
        where: { userId: user.id, email: gmailAddress },
      });
      const existingCount = await prisma.gmailToken.count({ where: { userId: user.id } });

      // Encrypt tokens before storing
      const encAccessToken = encryptToken(tokens.access_token!);
      const encRefreshToken = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null;

      if (existingToken) {
        await prisma.gmailToken.update({
          where: { id: existingToken.id },
          data: {
            accessToken: encAccessToken,
            refreshToken: encRefreshToken || existingToken.refreshToken,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          },
        });
      } else {
        await prisma.gmailToken.create({
          data: {
            userId: user.id,
            email: gmailAddress,
            accessToken: encAccessToken,
            refreshToken: encRefreshToken,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            primary: existingCount === 0, // 첫 번째 계정이면 primary
          },
        });
      }

      // 성공: 웹 앱으로 리다이렉트
      const frontendUrl = env.NODE_ENV === 'development' ? 'http://localhost:3000' : env.FRONTEND_URL;
      return reply.redirect(`${frontendUrl}/email`);
    } catch (error: any) {
      app.log.error({ err: error }, 'Gmail OAuth callback failed');
      return reply.code(400).send({ error: 'Gmail 연동 실패', details: error.message });
    }
  });
}

// ── 인증 필요 라우트 ──────────────────────────────────────
export async function emailRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── GET /api/email/auth/url ─────────────────────
  app.get('/api/email/auth/url', async (request, reply) => {
    try {
      const oauth2Client = createOAuth2Client();
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',  // 항상 새 refresh_token 발급 (재연동 시 필수)
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/drive.file',  // Google Docs 생성용
          // NOTE: Google Cloud Console에서 Calendar API + Drive API 활성화 필요
        ],
        state: signState(request.userId!),
      });
      return reply.send({ success: true, authUrl });
    } catch (error: any) {
      return reply.code(500).send({ error: 'OAuth URL 생성 실패', details: error.message });
    }
  });

  // ── GET /api/email/status ───────────────────────
  app.get('/api/email/status', async (request, reply) => {
    const userId = request.userId!;
    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.send({ success: true, connected: false });

      const allTokens = await prisma.gmailToken.findMany({
        where: { userId: user.id },
        orderBy: { primary: 'desc' },
      });
      if (allTokens.length === 0) return reply.send({ success: true, connected: false });

      const primaryToken = allTokens[0];
      // refresh_token이 있으면 access_token 만료와 무관하게 connected
      // Google OAuth2 클라이언트가 자동으로 refresh 처리함
      const hasRefreshToken = !!primaryToken.refreshToken;
      const rawProfile = await prisma.emailProfile.findUnique({ where: { userId: user.id } });

      return reply.send({
        success: true,
        connected: hasRefreshToken || (primaryToken.expiresAt ? primaryToken.expiresAt > new Date() : true),
        accounts: allTokens.map(t => ({
          id: t.id,
          email: t.email,
          label: t.label,
          primary: t.primary,
          expired: t.expiresAt ? t.expiresAt < new Date() : false,
        })),
        accountCount: allTokens.length,
        hasProfile: !!rawProfile,
        classifyByGroup: rawProfile?.classifyByGroup ?? false,
        groupCount: rawProfile ? (rawProfile.groups as any[]).length : 0,
        lastBriefingAt: rawProfile?.lastBriefingAt?.toISOString() || null,
        message: !hasRefreshToken && primaryToken.expiresAt && primaryToken.expiresAt < new Date() ? 'Gmail 토큰 만료' : `Gmail ${allTokens.length}개 계정 연동됨`,
      });
    } catch (error: any) {
      return reply.code(500).send({ error: 'Gmail 상태 확인 실패', details: error.message });
    }
  });

  // ── GET /api/email/profile ──────────────────────
  app.get('/api/email/profile', async (request, reply) => {
    const userId = request.userId!;
    const user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const rawProfile = await prisma.emailProfile.findUnique({ where: { userId: user.id } });

    if (!rawProfile) {
      return reply.send({
        success: true,
        data: {
          classifyByGroup: false,
          groups: [],
          excludePatterns: [],
          keywords: [],
          importanceRules: [],
          senderTimezones: [],
          timezone: 'America/New_York',
          lastBriefingAt: null,
        },
      });
    }

    const profile = parseProfile(rawProfile);
    return reply.send({
      success: true,
      data: profileToResponse(profile, rawProfile.lastBriefingAt),
    });
  });

  // ── PUT /api/email/profile ──────────────────────
  app.put('/api/email/profile', async (request, reply) => {
    const userId = request.userId!;
    const body = profileUpdateSchema.parse(request.body);
    const user = await ensureUser(userId);

    const data = {
      classifyByGroup: body.classifyByGroup,
      groups: body.groups as any,
      excludePatterns: (body.excludePatterns || []) as any,
      keywords: (body.keywords || []) as any,
      importanceRules: (body.importanceRules || []) as any,
      senderTimezones: (body.senderTimezones || []) as any,
      timezone: body.timezone || 'America/New_York',
    };

    const rawProfile = await prisma.emailProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });

    const profile = parseProfile(rawProfile);
    return reply.send({
      success: true,
      data: profileToResponse(profile, rawProfile.lastBriefingAt),
    });
  });

  // ── GET /api/email/briefing — 완전 개인화 이메일 브리핑 ─
  app.get('/api/email/briefing', async (request, reply) => {
    const query = briefingQuerySchema.parse(request.query);
    const userId = request.userId!;

    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

      const gmailToken = await prisma.gmailToken.findFirst({ where: { userId: user.id }, orderBy: { primary: 'desc' } });
      if (!gmailToken) return reply.code(401).send({ error: 'Gmail 미연동', authUrl: '/api/email/auth/url' });

      // 프로필 로드 (없으면 기본값)
      const rawProfile = await prisma.emailProfile.findUnique({ where: { userId: user.id } });
      const profile: UserProfile = rawProfile ? parseProfile(rawProfile) : {
        classifyByGroup: false,
        groups: [],
        excludePatterns: [],
        keywords: [],
        importanceRules: [],
        senderTimezones: [],
        timezone: 'America/New_York',
      };

      const timezone = profile.timezone;

      // T_last 결정: query.since > profile.lastBriefingAt > 24시간 전
      let afterDate: Date;
      if (query.since) {
        afterDate = new Date(query.since);
      } else if (rawProfile?.lastBriefingAt) {
        afterDate = rawProfile.lastBriefingAt;
      } else {
        afterDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 첫 브리핑: 24시간 전
      }

      // Gmail 검색 쿼리 구성
      const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
      const excludeSpam = query.includeSpam === 'false'
        ? '-category:promotions -category:social'
        : '';

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: safeDecrypt(gmailToken.accessToken),
        refresh_token: safeDecrypt(gmailToken.refreshToken),
        expiry_date: gmailToken.expiresAt?.getTime(),
      });
      // 토큰 자동 갱신 시 DB 업데이트 (암호화 저장)
      oauth2Client.on('tokens', async (tokens) => {
        try {
          await prisma.gmailToken.update({
            where: { id: gmailToken!.id },
            data: {
              accessToken: encryptToken(tokens.access_token!),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
            },
          });
        } catch (e) {
          console.error('토큰 갱신 DB 저장 실패:', e);
        }
      });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // 페이지네이션 수집 (최대 3페이지)
      let allMessageIds: Array<{ id: string; threadId: string }> = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 3; page++) {
        const listResponse = await gmail.users.messages.list({
          userId: 'me',
          maxResults: 50,
          q: `after:${afterStr} -from:me ${excludeSpam}`,
          pageToken,
        });

        const msgs = listResponse.data.messages || [];
        allMessageIds.push(...msgs.map(m => ({ id: m.id!, threadId: m.threadId! })));

        pageToken = listResponse.data.nextPageToken || undefined;
        if (!pageToken) break;
      }

      if (allMessageIds.length === 0) {
        return reply.send({
          success: true,
          data: [],
          meta: {
            total: 0, afterDate: afterDate.toISOString(), timezone,
            categories: { urgent: 0, 'action-needed': 0, schedule: 0, info: 0, ads: 0 },
            groups: {},
          },
        });
      }

      // 메시지 상세 조회 (1차: metadata)
      const batchSize = Math.min(allMessageIds.length, query.maxResults);
      const detailPromises = allMessageIds.slice(0, batchSize).map(msg =>
        gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] }),
      );
      const messages = await Promise.all(detailPromises);

      // 이메일 데이터 추출 + 필터링
      const rawEmails: Array<{
        index: number; messageId: string; threadId: string;
        sender: string; senderName: string; toCC: string;
        subject: string; snippet: string; date: string;
        internalDate: number; matchedTz: SenderTimezone | null;
      }> = [];

      let idx = 0;
      for (const msg of messages) {
        const headers = msg.data.payload?.headers || [];
        const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
        const internalDate = Number(msg.data.internalDate) || Date.now();

        // T_last 이후 메일만 (internalDate 기반 정밀 필터)
        if (internalDate < afterDate.getTime()) continue;

        const sender = getHeader('from');
        const subject = getHeader('subject') || '(제목 없음)';

        // 제외 필터 (프로필 기반만)
        if (isExcluded(subject, sender, profile.excludePatterns)) continue;

        // 발신자 시간대 매칭 (프로필 기반)
        const matchedTz = matchSenderTimezone(sender, profile.senderTimezones);

        rawEmails.push({
          index: idx++,
          messageId: msg.data.id!,
          threadId: msg.data.threadId || '',
          sender,
          senderName: sender.split('<')[0].trim() || sender,
          toCC: `${getHeader('to')} ${getHeader('cc')}`.trim(),
          subject,
          snippet: msg.data.snippet || '',
          date: getHeader('date'),
          internalDate,
          matchedTz,
        });
      }

      if (rawEmails.length === 0) {
        return reply.send({
          success: true,
          data: [],
          meta: {
            total: 0, afterDate: afterDate.toISOString(), timezone,
            categories: { urgent: 0, 'action-needed': 0, schedule: 0, info: 0, ads: 0 },
            groups: {},
          },
        });
      }

      // Sonnet 1차 분류 (snippet 기반)
      const classifications = await classifyEmailsWithSonnet(
        rawEmails.map(e => ({
          index: e.index,
          subject: e.subject,
          snippet: e.snippet,
          sender: e.sender,
          toCC: e.toCC,
        })),
        profile,
      );
      trackAICost(userId, 'claude-sonnet', COST_PER_CALL['claude-sonnet']);

      // 본문 열람이 필요한 메일 식별 + full body 가져오기
      if (query.includeBody === 'true') {
        const needsBodyIds: Array<{ idx: number; messageId: string }> = [];
        for (const email of rawEmails) {
          const cls = classifications.get(String(email.index));
          if (cls?.needsBody || cls?.category === 'urgent' || cls?.category === 'action-needed') {
            needsBodyIds.push({ idx: email.index, messageId: email.messageId });
          }
        }

        if (needsBodyIds.length > 0) {
          const bodyPromises = needsBodyIds.map(({ messageId }) =>
            gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
          );
          const bodyMessages = await Promise.all(bodyPromises);

          // 본문 포함하여 재분류
          const enrichedEmails = needsBodyIds.map((item, i) => {
            const email = rawEmails.find(e => e.index === item.idx)!;
            const body = extractBody(bodyMessages[i].data.payload);
            return {
              index: email.index,
              subject: email.subject,
              snippet: email.snippet,
              sender: email.sender,
              toCC: email.toCC,
              body,
            };
          });

          if (enrichedEmails.length > 0) {
            const reClassifications = await classifyEmailsWithSonnet(enrichedEmails, profile);
            trackAICost(userId, 'claude-sonnet', COST_PER_CALL['claude-sonnet']);

            // 재분류 결과 병합
            reClassifications.forEach((value, key) => {
              classifications.set(key, value);
            });

            // 본문 텍스트를 rawEmails에 첨부
            for (const enriched of enrichedEmails) {
              const email = rawEmails.find(e => e.index === enriched.index);
              if (email) (email as any).body = enriched.body;
            }
          }
        }
      }

      // 브리핑 결과 조합
      const briefings: EmailBriefing[] = rawEmails.map(email => {
        const cls = classifications.get(String(email.index)) || {
          category: 'info' as EmailCategory,
          confidence: 0.5,
          summary: email.subject.substring(0, 50),
          needsBody: false,
        };

        return {
          sender: email.sender,
          senderName: email.senderName,
          subject: email.subject,
          snippet: email.snippet,
          body: (cls.category === 'urgent' || cls.category === 'action-needed')
            ? (email as any).body || undefined
            : undefined,
          date: email.date,
          // 발신자 시간대 (프로필에 매핑이 있을 때만)
          dateSender: email.matchedTz
            ? formatDateWithTimezone(email.internalDate, email.matchedTz.timezone)
            : undefined,
          dateSenderLabel: email.matchedTz?.label || undefined,
          dateLocal: formatDateWithTimezone(email.internalDate, timezone),
          category: cls.category,
          categoryEmoji: CATEGORY_EMOJI[cls.category],
          group: cls.group || domainMatchGroup(email.sender, profile)?.name || '개인',
          groupEmoji: cls.groupEmoji || domainMatchGroup(email.sender, profile)?.emoji || '[개인]',
          summary: cls.summary,
          messageId: email.messageId,
          threadId: email.threadId,
          matchedTimezone: email.matchedTz?.timezone || undefined,
        };
      });

      // 정렬: urgent → action-needed → schedule → info → ads
      const categoryOrder: Record<EmailCategory, number> = {
        'urgent': 0, 'action-needed': 1, 'schedule': 2, 'info': 3, 'ads': 4,
      };
      briefings.sort((a, b) => categoryOrder[a.category] - categoryOrder[b.category]);

      // 통계
      const categoryCounts = {
        urgent: briefings.filter(b => b.category === 'urgent').length,
        'action-needed': briefings.filter(b => b.category === 'action-needed').length,
        schedule: briefings.filter(b => b.category === 'schedule').length,
        info: briefings.filter(b => b.category === 'info').length,
        ads: briefings.filter(b => b.category === 'ads').length,
      };

      const groupCounts: Record<string, number> = {};
      if (profile.classifyByGroup) {
        briefings.forEach(b => {
          if (b.group) groupCounts[b.group] = (groupCounts[b.group] || 0) + 1;
        });
      }

      // T_last 업데이트
      const now = new Date();
      if (rawProfile) {
        await prisma.emailProfile.update({
          where: { userId: user.id },
          data: { lastBriefingAt: now },
        });
      } else {
        await prisma.emailProfile.create({
          data: {
            userId: user.id,
            classifyByGroup: false,
            groups: [],
            lastBriefingAt: now,
          },
        });
      }

      // 비동기 지식 그래프 관계 추출
      const emailGraphText = briefings
        .slice(0, 10)
        .map((b: any) => `${b.senderName || b.sender}: ${b.subject} — ${b.summary || ''}`)
        .join('\n');
      if (emailGraphText.length > 20) {
        buildGraphFromText(userId, emailGraphText, 'email').catch(() => {});
      }

      // 일정 메일에서 이벤트 감지 → pending events
      const scheduleEmails = briefings.filter((b: any) => b.category === 'schedule');
      if (scheduleEmails.length > 0) {
        import('../services/calendar.js').then(({ detectEventsFromText }) => {
          const schedText = scheduleEmails.map((b: any) => `${b.subject}: ${b.summary}`).join('\n');
          detectEventsFromText(schedText, 'email', 'briefing-' + now.toISOString().split('T')[0])
            .then(async (events) => {
              const { savePendingEvent } = await import('./calendar.js');
              for (const evt of events) {
                await savePendingEvent(user!.id, request.labId, evt);
              }
            });
        }).catch(() => {});
      }

      // 브리핑 히스토리 저장 (Memo에 JSON 형태로)
      try {
        await prisma.memo.create({
          data: {
            userId: user.id,
            labId: request.labId || undefined,
            title: `이메일 브리핑 ${now.toISOString().split('T')[0]}`,
            content: JSON.stringify({
              briefings,
              meta: {
                total: briefings.length,
                afterDate: afterDate.toISOString(),
                lastBriefingAt: now.toISOString(),
                timezone,
                categories: categoryCounts,
                groups: groupCounts,
              },
            }),
            tags: ['email-briefing', 'auto'],
            source: 'email-briefing',
          },
        });
      } catch {
        // 히스토리 저장 실패는 무시
      }

      return reply.send({
        success: true,
        data: briefings,
        meta: {
          total: briefings.length,
          afterDate: afterDate.toISOString(),
          lastBriefingAt: now.toISOString(),
          timezone,
          categories: categoryCounts,
          groups: groupCounts,
          classifiedBy: env.ANTHROPIC_API_KEY ? 'sonnet' : 'fallback',
          excludedCount: messages.length - rawEmails.length,
        },
      });
    } catch (error: any) {
      app.log.error('이메일 브리핑 실패:', error);

      if (error.message?.includes('invalid_grant') || error.message?.includes('401')) {
        return reply.code(401).send({ error: 'Gmail 토큰 만료', authUrl: '/api/email/auth/url' });
      }

      return reply.code(500).send({ error: '이메일 브리핑 실패', details: error.message });
    }
  });

  // ── GET /api/email/narrative-briefing — 서사형 AI 브리핑 ──
  app.get('/api/email/narrative-briefing', async (request, reply) => {
    const query = briefingQuerySchema.parse(request.query);
    const userId = request.userId!;

    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

      const gmailToken = await prisma.gmailToken.findFirst({ where: { userId: user.id }, orderBy: { primary: 'desc' } });
      if (!gmailToken) return reply.code(401).send({ error: 'Gmail 미연동', authUrl: '/api/email/auth/url' });

      const rawProfile = await prisma.emailProfile.findUnique({ where: { userId: user.id } });
      const profile: UserProfile = rawProfile ? parseProfile(rawProfile) : {
        classifyByGroup: false, groups: [], excludePatterns: [],
        keywords: [], importanceRules: [], senderTimezones: [], timezone: 'America/New_York',
      };
      const timezone = profile.timezone;

      // T_last 결정
      // T_last 결정: query.since > profile.lastBriefingAt > 24시간 전
      let afterDate: Date;
      if (query.since) {
        afterDate = new Date(query.since);
      } else if (rawProfile?.lastBriefingAt) {
        afterDate = rawProfile.lastBriefingAt;
      } else {
        afterDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 첫 브리핑: 24시간 전
      }

      const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
      const excludeSpam = query.includeSpam === 'false' ? '-category:promotions -category:social' : '';

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: safeDecrypt(gmailToken.accessToken),
        refresh_token: safeDecrypt(gmailToken.refreshToken),
        expiry_date: gmailToken.expiresAt?.getTime(),
      });
      oauth2Client.on('tokens', async (tokens) => {
        try {
          await prisma.gmailToken.update({
            where: { id: gmailToken!.id },
            data: {
              accessToken: encryptToken(tokens.access_token!),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
            },
          });
        } catch {}
      });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // 페이지네이션 수집 (최대 3페이지)
      let allMessageIds: Array<{ id: string; threadId: string }> = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 3; page++) {
        const listResponse = await gmail.users.messages.list({
          userId: 'me', maxResults: 50,
          q: `after:${afterStr} -from:me ${excludeSpam}`,
          pageToken,
        });
        const msgs = listResponse.data.messages || [];
        allMessageIds.push(...msgs.map(m => ({ id: m.id!, threadId: m.threadId! })));
        pageToken = listResponse.data.nextPageToken || undefined;
        if (!pageToken) break;
      }

      if (allMessageIds.length === 0) {
        return reply.send({
          success: true,
          markdown: '# 이메일 브리핑\n\n새로운 이메일이 없습니다.',
          emailCount: 0,
          generatedAt: new Date().toISOString(),
        });
      }

      // 메시지 상세 조회
      const batchSize = Math.min(allMessageIds.length, query.maxResults);
      const detailPromises = allMessageIds.slice(0, batchSize).map(msg =>
        gmail.users.messages.get({
          userId: 'me', id: msg.id,
          format: query.includeBody === 'true' ? 'full' : 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        }),
      );
      const messages = await Promise.all(detailPromises);

      // 이메일 데이터 추출
      interface ParsedEmail {
        index: number; messageId: string; threadId: string;
        sender: string; senderName: string;
        subject: string; snippet: string; body: string; dateStr: string;
        toCC: string; groupLabel: string; internalDate: number;
      }
      const parsedEmails: ParsedEmail[] = [];
      let emailCount = 0;

      // 주간보고 제외 패턴
      const isWeeklyReport = (subject: string, sender: string) =>
        /weekly\s*report/i.test(subject) || subject.includes('주간 진행사항 보고');

      for (const msg of messages) {
        const headers = msg.data.payload?.headers || [];
        const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
        const internalDate = Number(msg.data.internalDate) || Date.now();

        if (internalDate < afterDate.getTime()) continue;

        const sender = getHeader('from');
        const subject = getHeader('subject') || '(제목 없음)';

        if (isExcluded(subject, sender, profile.excludePatterns)) continue;
        if (isWeeklyReport(subject, sender)) continue; // 주간보고 제외

        const senderName = sender.split('<')[0].trim() || sender;
        const snippet = msg.data.snippet || '';
        const body = query.includeBody === 'true' ? extractBody(msg.data.payload) : '';
        const dateStr = formatDateWithTimezone(internalDate, timezone);
        const toCC = `${getHeader('to')} ${getHeader('cc')}`.trim();

        // 기관 분류: profile.groups의 도메인으로 To/Cc + From 동적 매칭
        let groupLabel = '[개인]';
        const allAddresses = `${toCC} ${sender}`.toLowerCase();
        if (profile.classifyByGroup && profile.groups.length > 0) {
          for (const g of profile.groups) {
            if (g.domains?.some((d: string) => allAddresses.includes(d.toLowerCase()))) {
              groupLabel = `${g.emoji}${g.name}`;
              break;
            }
          }
        }

        parsedEmails.push({
          index: emailCount,
          messageId: msg.data.id || '',
          threadId: msg.data.threadId || '',
          sender, senderName, subject, snippet, body, dateStr, toCC, groupLabel,
          internalDate,
        });
        emailCount++;
      }

      if (parsedEmails.length === 0) {
        return reply.send({
          success: true,
          markdown: '# 이메일 브리핑\n\n새로운 이메일이 없습니다.',
          emailCount: 0,
          generatedAt: new Date().toISOString(),
        });
      }

      // ── Stage 1: Gemini Flash 배치 분류 ──
      const stage1Inputs: Stage1Input[] = parsedEmails.map(e => ({
        index: e.index,
        subject: e.subject,
        from: e.sender,
        snippet: e.snippet.substring(0, 200),
        toCC: e.toCC,
      }));

      const profileForClassification: UserProfileForClassification = {
        classifyByGroup: profile.classifyByGroup,
        groups: profile.groups,
        keywords: profile.keywords,
        importanceRules: profile.importanceRules,
      };

      let stage1Results: Stage1Result[];
      try {
        stage1Results = await classifyEmailBatchStage1(stage1Inputs, profileForClassification, null);
      } catch (err) {
        console.warn('Stage 1 (Gemini) 실패, 기본 분류 적용:', err);
        stage1Results = stage1Inputs.map(e => ({
          index: e.index, priority: 'medium' as const,
          category: 'info' as const, needs_detail: false, reason: 'fallback',
        }));
      }

      // Stage 1 결과를 이메일 데이터에 매핑
      const classificationMap = new Map(stage1Results.map(r => [r.index, r]));

      // ── Stage 2: Sonnet 서사형 마크다운 생성 ──

      // 이전 브리핑 맥락 로드 (연속성: Medtronic 대기 중 등 추적)
      let previousBriefing = '';
      try {
        const lastBriefingMemo = await prisma.memo.findFirst({
          where: { userId: user.id, source: 'email-briefing', tags: { has: 'narrative' } },
          orderBy: { createdAt: 'desc' },
        });
        if (lastBriefingMemo) {
          previousBriefing = lastBriefingMemo.content.substring(0, 3000);
        }
      } catch {}

      // 스레드 그룹핑: 같은 threadId의 이메일을 묶음
      const threadGroups = new Map<string, ParsedEmail[]>();
      for (const e of parsedEmails) {
        const tid = e.threadId || e.messageId;
        if (!threadGroups.has(tid)) threadGroups.set(tid, []);
        threadGroups.get(tid)!.push(e);
      }

      // 이메일 데이터 구성 (본문 열람 규칙 적용)
      const emailDataForPrompt: string[] = parsedEmails.map(e => {
        const cls = classificationMap.get(e.index);
        const categoryLabel = cls ? `${CATEGORY_EMOJI[cls.category] || '[정보]'}${cls.category}` : '[정보]info';
        const priorityLabel = cls?.priority || 'medium';

        // 스레드 내 다른 메일 표시
        const threadEmails = threadGroups.get(e.threadId || e.messageId) || [];
        const isThread = threadEmails.length > 1;

        let text = `[${e.index + 1}] [${e.groupLabel}] [${categoryLabel}] [${priorityLabel}]`;
        text += `\n   From: ${e.senderName} <${e.sender.match(/<(.+)>/)?.[1] || e.sender}>`;
        text += `\n   To/Cc: ${e.toCC.substring(0, 150)}`;
        text += `\n   제목: ${e.subject}`;
        text += `\n   날짜: ${e.dateStr}`;
        text += `\n   미리보기: ${e.snippet}`;

        // 본문 열람 규칙: 긴급/대응필요 → 전체 본문, 소속 기관 도메인 발송 → 본문
        const isUrgentOrAction = cls?.category === 'urgent' || cls?.category === 'action-needed';
        // 동적: 사용자의 첫 번째 그룹(소속 기관) 도메인으로 학생/내부 이메일 판별
        const primaryDomains = profile.groups?.[0]?.domains || [];
        const isInternalEmail = primaryDomains.some((d: string) => e.sender.toLowerCase().includes(d.toLowerCase()));
        // 동적: 사용자 이름으로 "Dear {name}" 패턴 매칭
        const userFirstName = (user.name || '').split(' ').pop()?.toLowerCase() || '';
        const isDearUser = userFirstName.length > 1 && e.snippet?.toLowerCase().includes(`dear ${userFirstName}`);
        if (e.body && e.body.length > 10 && (isUrgentOrAction || isInternalEmail || isDearUser || cls?.needs_detail)) {
          text += `\n   본문:\n${e.body.substring(0, 1000)}`;
        }

        if (isThread) {
          text += `\n   [스레드: ${threadEmails.length}건 — ${threadEmails.map(t => t.senderName).join(' → ')}]`;
        }

        return text;
      });

      // 분류 통계
      const urgentCount = stage1Results.filter(r => r.category === 'urgent').length;
      const actionCount = stage1Results.filter(r => r.category === 'action-needed').length;
      const scheduleCount = stage1Results.filter(r => r.category === 'schedule').length;
      const infoCount = stage1Results.filter(r => r.category === 'info').length;
      const adsCount = stage1Results.filter(r => r.category === 'ads').length;

      // 동적 프로필 데이터 로드 (프롬프트 생성 + 자동 학습 양쪽에서 사용)
      const projectCtx = (rawProfile as any)?.projectContext || {};
      const keyPeople = ((rawProfile as any)?.keyPeople || []) as Array<{name: string; role?: string; email?: string; org?: string; relationship?: string}>;
      const activeThreads = ((rawProfile as any)?.activeThreads || []) as Array<{topic: string; status?: string; lastUpdate?: string; parties?: string[]}>;
      const briefingStyle = (rawProfile as any)?.briefingStyle || {};
      const learnedPatterns = (rawProfile as any)?.learnedPatterns || {};

      const anthropic = createAnthropicClient();
      let markdown: string;

      if (anthropic) {
        const todayStr = new Date().toLocaleDateString('ko-KR', {
          timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
        });
        const timeStr = new Date().toLocaleTimeString('ko-KR', {
          timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const tzLabel = timezone.includes('New_York') ? 'EDT' : timezone.includes('Seoul') ? 'KST' : timezone;
        const afterTimeStr = formatDateWithTimezone(afterDate.getTime(), timezone);

        // 프로필에서 동적 맥락 생성
        const userName = user.name || '사용자';
        const userRole = projectCtx.role || '';
        const userOrg = projectCtx.organization || '';
        const userLocation = projectCtx.location || '';
        const researchAreas = (projectCtx.researchAreas || []).join(', ');

        let peopleSection = '';
        if (keyPeople.length > 0) {
          peopleSection = `## 핵심 인물 (이전 브리핑에서 축적된 정보)\n` +
            keyPeople.map(p => `- ${p.name}${p.role ? ` (${p.role})` : ''}${p.org ? ` — ${p.org}` : ''}${p.relationship ? `: ${p.relationship}` : ''}`).join('\n');
        }

        let threadsSection = '';
        if (activeThreads.length > 0) {
          threadsSection = `## 추적 중인 건 (이전 브리핑에서 업데이트 확인)\n` +
            activeThreads.map(t => `- ${t.topic}: ${t.status || '진행 중'}${t.parties?.length ? ` (${t.parties.join(', ')})` : ''}`).join('\n');
        }

        // 기관별 그룹 동적 생성
        const groupRules = profile.classifyByGroup && profile.groups.length > 0
          ? profile.groups.map(g => `- ${g.emoji} ${g.name}: ${g.domains.join(', ')}`).join('\n')
          : '- 기관별 분류는 To/Cc 주소의 도메인으로 판별합니다.';

        const customInstructions = briefingStyle.customInstructions || '';
        const excludeWeeklyReport = briefingStyle.excludeWeeklyReport !== false;

        const narrativePrompt = `당신은 ${userName}${userRole ? `(${userRole})` : ''}의 이메일 브리핑 비서입니다.
${userOrg ? `소속: ${userOrg}. ` : ''}${userLocation ? `현재 위치: ${userLocation}. ` : ''}기준 시간대: ${tzLabel}.
${researchAreas ? `연구/사업 분야: ${researchAreas}` : ''}

${peopleSection}

${threadsSection}

## 기관별 분류
${groupRules}
- 분류 기준: To/Cc 주소의 도메인. 매칭되지 않으면 [개인].

## 성격별 분류
| 라벨 | 분류 | 설명 |
|--------|------|------|
| [긴급] | 긴급 | 마감 24시간 이내 또는 즉각 조치 필요 |
| [대응] | 대응필요 | 교수님 의견·결정·승인 요청, 저널 의사결정, 명시적 회신 요청 |
| [일정] | 일정 | 날짜/시간 포함 이벤트, 마감일, 미팅 |
| [정보] | 정보성 | 공지, 뉴스레터, 알림, CC |
| [광고] | 광고 | 프로모션, Call for Papers, 투고 초대 |

## 중요도 조정
${(profile.keywords as string[]).length > 0 ? `- 연구/사업 키워드(${(profile.keywords as string[]).join(', ')}) → 1단계 상향` : ''}
- Submission confirmation, Decision, Review results → [긴급] 최우선 상향
- Call for Papers, 투고 초대 → [정보] 또는 [광고] 강등

## Gemini 1차 분류 통계
긴급 ${urgentCount} · 대응필요 ${actionCount} · 일정 ${scheduleCount} · 정보성 ${infoCount} · 광고 ${adsCount}

${previousBriefing ? `## 이전 브리핑 (연속성 참고용)\n${previousBriefing.substring(0, 2000)}\n\n위 이전 브리핑에서 추적 중인 건의 상태가 업데이트되었는지 확인하고, 요약에 진행 상황을 반영하세요.` : ''}

## 출력 포맷 (정확히 따르세요)

이메일 브리핑 — ${todayStr} ${timeStr} ${tzLabel}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
총 ~N건 신규 (${afterTimeStr} 이후) | 긴급 N건 · 대응필요 N건 · 정보성 N건+ · 광고 ~N건

${profile.groups.length > 0
  ? profile.groups.map((g: any) => `${g.name} (N건)\n──────────────\n(분류 라벨 + 제목 + 시간 + 맥락 분석)`).join('\n\n')
  : '수신 이메일 (N건)\n──────────────\n(분류 라벨 + 제목 + 시간 + 맥락 분석)'}

개인 (N건)
──────────────
(위 기관에 해당하지 않는 메일)

광고/프로모션 (N건)
[발신자] · [발신자] · ... (한 줄 압축)

### 요약
━━━━━━
오늘 완료된 것들: 항목
즉시 대응: [긴급]/[대응] 구체적 액션
진행 상황 업데이트: 이전 브리핑에서 추적 중인 건의 현재 상태
이번 주 일정: 날짜별 정리

## 압축 규칙
- [긴급]/[대응]: 핵심 내용 최대 2줄 + 조치사항(→) 1줄. 스레드 히스토리는 간결하게 합침.
- [정보]: "발신자 (시간) — 한 줄" 만.
- 다건 동일 성격: "전자결재 수신참조 (3건): 항목1, 항목2, 항목3" 한 줄 묶음.
- [광고]: [발신자] · [발신자] 형태로 압축. 학술지 초대도 여기 포함.
- 조치 없는 항목에는 → 달지 않음.
- 한국발 메일: KST → ${tzLabel} 병기. 예: 09:22 KST (전일 19:22 ${tzLabel})
- 같은 스레드의 여러 메일은 타임라인으로 합쳐서 한 항목으로 정리 (답장 내용 포함)
- 한국어로 작성. 마크다운 문법. HTML 금지.

응답에 이모지를 절대 사용하지 마라. 이모지 대신 대괄호 라벨([긴급], [대응] 등)과 마크다운 서식으로 구조를 표현하라.`;

        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8192,
            temperature: 0.2,
            system: narrativePrompt,
            messages: [{
              role: 'user',
              content: `다음 이메일 ${emailDataForPrompt.length}건을 분석하여 서사형 브리핑을 작성해주세요:\n\n${emailDataForPrompt.join('\n\n')}`,
            }],
          });

          trackAICost(userId, 'claude-sonnet', COST_PER_CALL['claude-sonnet']);
          const textBlock = response.content.find(b => b.type === 'text');
          markdown = textBlock && textBlock.type === 'text' ? textBlock.text : '브리핑 생성에 실패했습니다.';
        } catch (err: any) {
          console.error('서사형 브리핑 Sonnet 호출 실패:', err);
          markdown = generateFallbackNarrative(emailDataForPrompt, timezone);
        }
      } else {
        markdown = generateFallbackNarrative(emailDataForPrompt, timezone);
      }

      // T_last 업데이트
      const now = new Date();
      if (rawProfile) {
        await prisma.emailProfile.update({
          where: { userId: user.id },
          data: { lastBriefingAt: now },
        });
      } else {
        await prisma.emailProfile.create({
          data: { userId: user.id, classifyByGroup: false, groups: [], lastBriefingAt: now },
        });
      }

      // 자동 학습: 이메일에서 핵심 인물/발신자 패턴 축적
      try {
        const currentPeople = [...keyPeople];
        const currentSenderMap = (learnedPatterns.senderMap || {}) as Record<string, {name: string; org: string; count: number}>;

        for (const e of parsedEmails) {
          const emailAddr = (e.sender.match(/<(.+)>/) || [])[1] || e.sender;
          if (!emailAddr || emailAddr.includes('noreply') || emailAddr.includes('no-reply')) continue;

          // 발신자 맵 업데이트 (빈도 카운트)
          if (currentSenderMap[emailAddr]) {
            currentSenderMap[emailAddr].count++;
          } else {
            currentSenderMap[emailAddr] = { name: e.senderName, org: e.groupLabel, count: 1 };
          }

          // 빈도 높은 발신자(5회 이상)를 keyPeople에 자동 추가
          if (currentSenderMap[emailAddr].count >= 5) {
            const alreadyExists = currentPeople.some(p =>
              p.name === e.senderName || p.email === emailAddr
            );
            if (!alreadyExists) {
              currentPeople.push({
                name: e.senderName,
                email: emailAddr,
                org: e.groupLabel.replace(/\[개인\]/g, '').trim(),
                relationship: 'frequent correspondent',
              });
            }
          }
        }

        // 추적 중인 건 업데이트: 긴급/대응필요 항목 추출
        const currentThreads = [...activeThreads];
        for (const e of parsedEmails) {
          const cls = classificationMap.get(e.index);
          if (cls?.category === 'urgent' || cls?.category === 'action-needed') {
            const existingThread = currentThreads.find(t =>
              e.subject.toLowerCase().includes(t.topic.toLowerCase()) ||
              t.topic.toLowerCase().includes(e.subject.substring(0, 30).toLowerCase())
            );
            if (existingThread) {
              existingThread.lastUpdate = now.toISOString();
              existingThread.status = '진행 중';
            } else if (e.subject.length > 5) {
              currentThreads.push({
                topic: e.subject.substring(0, 80),
                status: '신규',
                lastUpdate: now.toISOString(),
                parties: [e.senderName],
              });
            }
          }
        }

        // 오래된 추적 건 정리 (30일 초과)
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const activeThreadsFiltered = currentThreads
          .filter(t => !t.lastUpdate || t.lastUpdate > thirtyDaysAgo)
          .slice(0, 20); // 최대 20건

        // Profile 업데이트
        await prisma.emailProfile.update({
          where: { userId: user.id },
          data: {
            keyPeople: currentPeople.slice(0, 50) as any,
            activeThreads: activeThreadsFiltered as any,
            learnedPatterns: { ...learnedPatterns, senderMap: currentSenderMap } as any,
          },
        });
      } catch (err) {
        console.warn('Auto-learn failed:', err);
      }

      // 히스토리 저장
      try {
        await prisma.memo.create({
          data: {
            userId: user.id,
            labId: request.labId || undefined,
            title: `서사형 브리핑 ${now.toISOString().split('T')[0]}`,
            content: markdown.substring(0, 10000),
            tags: ['email-briefing', 'narrative', 'auto'],
            source: 'email-briefing',
          },
        });
      } catch {}

      return reply.send({
        success: true,
        markdown,
        emailCount,
        generatedAt: now.toISOString(),
      });
    } catch (error: any) {
      app.log.error('서사형 이메일 브리핑 실패:', error);
      if (error.message?.includes('invalid_grant') || error.message?.includes('401')) {
        return reply.code(401).send({ error: 'Gmail 토큰 만료', authUrl: '/api/email/auth/url' });
      }
      return reply.code(500).send({ error: '이메일 브리핑 실패', details: error.message });
    }
  });

  // ── POST /api/email/draft — 답장 초안 → Gmail 임시보관함 ──
  app.post('/api/email/draft', async (request, reply) => {
    const schema = z.object({
      threadId: z.string().optional(),
      to: z.string().min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      inReplyTo: z.string().optional(), // Message-ID header for threading
    });
    const { threadId, to, subject, body, inReplyTo } = schema.parse(request.body);
    const userId = request.userId!;

    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

      const gmailToken = await prisma.gmailToken.findFirst({ where: { userId: user.id }, orderBy: { primary: 'desc' } });
      if (!gmailToken) return reply.code(401).send({ error: 'Gmail 연동이 필요합니다' });

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: safeDecrypt(gmailToken.accessToken),
        refresh_token: safeDecrypt(gmailToken.refreshToken),
        expiry_date: gmailToken.expiresAt?.getTime(),
      });
      oauth2Client.on('tokens', async (tokens) => {
        try {
          await prisma.gmailToken.update({
            where: { id: gmailToken.id },
            data: {
              accessToken: encryptToken(tokens.access_token!),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
            },
          });
        } catch {}
      });

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // RFC 2822 형식 이메일 조립
      const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
      ];
      if (inReplyTo) {
        headers.push(`In-Reply-To: ${inReplyTo}`);
        headers.push(`References: ${inReplyTo}`);
      }
      const rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
      const encodedMessage = Buffer.from(rawMessage).toString('base64url');

      const draft = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedMessage,
            threadId: threadId || undefined,
          },
        },
      });

      return reply.code(201).send({
        success: true,
        draftId: draft.data.id,
        message: '답장 초안이 Gmail 임시보관함에 저장되었습니다.',
      });
    } catch (error: any) {
      app.log.error('답장 초안 생성 실패:', error);
      return reply.code(500).send({ error: '답장 초안 생성 실패', details: error.message });
    }
  });

  // ── POST /api/email/translate — 이메일 본문 번역 (Gemini Flash) ──
  app.post('/api/email/translate', async (request, reply) => {
    const schema = z.object({
      text: z.string().min(1),
      targetLang: z.string().default('ko'),
    });
    const { text, targetLang } = schema.parse(request.body);

    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const result = await model.generateContent(
        `다음 이메일 본문을 ${targetLang === 'ko' ? '한국어' : targetLang}로 자연스럽게 번역하세요. 번역문만 출력하세요.\n\n${text}`
      );
      trackAICost(request.userId!, 'gemini-flash', COST_PER_CALL['gemini-flash']);

      return reply.send({
        success: true,
        translated: result.response.text(),
        targetLang,
      });
    } catch (error: any) {
      return reply.code(500).send({ error: '번역 실패', details: error.message });
    }
  });

  // ── POST /api/email/extract-actions — 이메일에서 할일/일정 추출 → Capture + Calendar ──
  app.post('/api/email/extract-actions', async (request, reply) => {
    const schema = z.object({
      subject: z.string(),
      body: z.string().min(1),
      sender: z.string().optional(),
    });
    const { subject, body: emailBody, sender } = schema.parse(request.body);
    const userId = request.userId!;

    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const result = await model.generateContent(`다음 이메일에서 할일(tasks)과 일정(events)을 추출하세요. JSON으로만 응답:

이메일 제목: ${subject}
발신자: ${sender || '알 수 없음'}
본문: ${emailBody.substring(0, 2000)}

응답 형식:
{
  "tasks": [{"title": "...", "priority": "HIGH|MEDIUM|LOW", "dueDate": "YYYY-MM-DD or null"}],
  "events": [{"title": "...", "date": "YYYY-MM-DD", "time": "HH:mm or null", "location": "... or null", "description": "..."}]
}

없으면 빈 배열로.`);
      trackAICost(userId, 'gemini-flash', COST_PER_CALL['gemini-flash']);

      const text = result.response.text().trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        return reply.send({ success: true, tasks: [], events: [], captures: [] });
      }

      const extracted = JSON.parse(match[0]);
      const captures: any[] = [];

      // 할일 → Capture 생성
      const user = await prisma.user.findFirst({ where: { id: userId } });
      const lab = user ? await prisma.lab.findUnique({ where: { ownerId: user.id } }) : null;

      for (const task of (extracted.tasks || [])) {
        if (!task.title) continue;
        const capture = await prisma.capture.create({
          data: {
            userId: user?.id || userId,
            labId: lab?.id || null,
            content: `[이메일] ${task.title} (from: ${sender || subject})`,
            summary: task.title,
            category: 'TASK',
            tags: ['email', 'action-item'],
            priority: task.priority === 'HIGH' ? 'HIGH' : task.priority === 'LOW' ? 'LOW' : 'MEDIUM',
            actionDate: task.dueDate ? new Date(task.dueDate) : null,
            modelUsed: 'gemini-flash',
            sourceType: 'text',
            status: 'active',
          },
        });
        captures.push(capture);
      }

      return reply.send({
        success: true,
        tasks: extracted.tasks || [],
        events: extracted.events || [],
        captures,
        message: `할일 ${captures.length}개 → Capture 저장. 일정 ${(extracted.events || []).length}개 추출.`,
      });
    } catch (error: any) {
      return reply.code(500).send({ error: '액션 추출 실패', details: error.message });
    }
  });

  // ── POST /api/email/calendar-event — Google Calendar 이벤트 생성 ──
  // NOTE: Google Cloud Console에서 Calendar API 활성화 + OAuth 스코프 추가 필요
  app.post('/api/email/calendar-event', async (request, reply) => {
    const schema = z.object({
      title: z.string().min(1),
      date: z.string().min(1), // YYYY-MM-DD
      time: z.string().optional(), // HH:mm
      duration: z.number().default(60), // minutes
      location: z.string().optional(),
      description: z.string().optional(),
    });
    const { title, date, time, duration, location, description } = schema.parse(request.body);
    const userId = request.userId!;

    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

      const gmailToken = await prisma.gmailToken.findFirst({ where: { userId: user.id }, orderBy: { primary: 'desc' } });
      if (!gmailToken) return reply.code(401).send({ error: 'Gmail/Calendar 연동이 필요합니다' });

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: safeDecrypt(gmailToken.accessToken),
        refresh_token: safeDecrypt(gmailToken.refreshToken),
        expiry_date: gmailToken.expiresAt?.getTime(),
      });
      oauth2Client.on('tokens', async (tokens) => {
        try {
          await prisma.gmailToken.update({
            where: { id: gmailToken.id },
            data: {
              accessToken: encryptToken(tokens.access_token!),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
            },
          });
        } catch {}
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const startDateTime = time
        ? `${date}T${time}:00`
        : `${date}T09:00:00`;
      const endDate = new Date(startDateTime);
      endDate.setMinutes(endDate.getMinutes() + duration);

      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: title,
          location: location || undefined,
          description: description || undefined,
          start: time
            ? { dateTime: startDateTime, timeZone: 'Asia/Seoul' }
            : { date },
          end: time
            ? { dateTime: endDate.toISOString(), timeZone: 'Asia/Seoul' }
            : { date },
        },
      });

      return reply.code(201).send({
        success: true,
        eventId: event.data.id,
        htmlLink: event.data.htmlLink,
        message: `캘린더 이벤트 생성: ${title} (${date}${time ? ' ' + time : ''})`,
      });
    } catch (error: any) {
      // Calendar API 미활성화 시 명확한 에러 메시지
      if (error.message?.includes('Calendar API') || error.code === 403) {
        return reply.code(403).send({
          error: 'Google Calendar API가 활성화되지 않았습니다',
          hint: 'Google Cloud Console에서 Calendar API 활성화 + OAuth 스코프(calendar.events)를 추가해주세요.',
        });
      }
      return reply.code(500).send({ error: '캘린더 이벤트 생성 실패', details: error.message });
    }
  });

  // ── GET /api/email/messages/recent — 최근 이메일 목록 (전문 포함) ──
  app.get('/api/email/messages/recent', async (request, reply) => {
    const userId = request.userId!;
    const query = request.query as { limit?: string; q?: string };
    const limit = Math.min(parseInt(query.limit || '5', 10) || 5, 10);
    const searchQuery = (query.q || '').trim();

    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: 'User not found' });

      const gmailToken = await prisma.gmailToken.findFirst({ where: { userId: user.id }, orderBy: { primary: 'desc' } });
      if (!gmailToken) return reply.code(401).send({ error: 'Gmail not connected' });

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: safeDecrypt(gmailToken.accessToken),
        refresh_token: safeDecrypt(gmailToken.refreshToken),
        expiry_date: gmailToken.expiresAt?.getTime(),
      });
      oauth2Client.on('tokens', async (tokens) => {
        try {
          await prisma.gmailToken.update({
            where: { id: gmailToken.id },
            data: {
              accessToken: encryptToken(tokens.access_token!),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
            },
          });
        } catch { /* ignore token refresh save error */ }
      });

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const listRes = await gmail.users.messages.list({
        userId: 'me',
        maxResults: limit,
        q: searchQuery || undefined,
      });

      const messageIds = listRes.data.messages || [];
      if (messageIds.length === 0) return reply.send({ emails: [] });

      // Fetch full message details in parallel
      const emails = await Promise.all(
        messageIds.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'full',
          });

          const headers = detail.data.payload?.headers || [];
          const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

          // Extract body text using existing extractBody helper
          const body = detail.data.payload ? extractBody(detail.data.payload) : '';

          return {
            id: msg.id,
            threadId: detail.data.threadId,
            from: getHeader('From'),
            to: getHeader('To'),
            cc: getHeader('Cc'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            snippet: detail.data.snippet || '',
            body,
            messageId: getHeader('Message-ID'),
          };
        })
      );

      return reply.send({ emails });
    } catch (error: any) {
      app.log.error('Recent emails fetch failed:', error);
      return reply.code(500).send({ error: '이메일 조회 실패', details: error.message });
    }
  });

  // ── GET /api/email/briefing/history — 이메일 브리핑 히스토리 ──
  app.get('/api/email/briefing/history', async (request, reply) => {
    const userId = request.userId!;
    const query = z.object({
      days: z.coerce.number().min(1).max(90).default(30),
      limit: z.coerce.number().min(1).max(50).default(20),
    }).parse(request.query);

    try {
      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

      const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);

      const memos = await prisma.memo.findMany({
        where: {
          userId: user.id,
          source: 'email-briefing',
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      });

      const history = memos.map(m => {
        let parsed: any = {};
        try { parsed = JSON.parse(m.content); } catch { /* ignore */ }
        return {
          id: m.id,
          date: m.createdAt.toISOString().split('T')[0],
          time: m.createdAt.toISOString(),
          title: m.title,
          briefings: parsed.briefings || [],
          meta: parsed.meta || {},
        };
      });

      return reply.send({ success: true, data: history, count: history.length });
    } catch (error: any) {
      return reply.code(500).send({ error: '히스토리 조회 실패', details: error.message });
    }
  });

  // ── POST /api/email/profile/init — 기본 프로필 초기화 ──
  app.post('/api/email/profile/init', async (request, reply) => {
    const userId = request.userId!;
    const user = await ensureUser(userId);

    const existing = await prisma.emailProfile.findUnique({ where: { userId: user.id } });
    if (existing) {
      return reply.send({ success: true, message: '이미 설정된 프로필이 있습니다', initialized: false });
    }

    // 새 유저: 빈 프로필로 시작. 사용하면서 자동 학습됨.
    const defaultProfile = {
      classifyByGroup: false,
      groups: [] as any,
      excludePatterns: [] as any,
      keywords: [] as any,
      importanceRules: [
        { condition: '저널 Decision, Review results, Revision 메일', action: 'urgent로 상향', description: '논문 의사결정' },
        { condition: 'Submission confirmation 메일', action: 'urgent로 상향', description: '투고 확인' },
        { condition: 'Call for Papers, 투고 초대', action: 'ads로 강등', description: 'CfP는 광고 처리' },
      ] as any,
      senderTimezones: [] as any,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      projectContext: {} as any,
      keyPeople: [] as any,
      activeThreads: [] as any,
      briefingStyle: {} as any,
      learnedPatterns: {} as any,
    };

    const rawProfile = await prisma.emailProfile.create({
      data: { userId: user.id, ...defaultProfile },
    });

    const profile = parseProfile(rawProfile);
    return reply.send({
      success: true,
      initialized: true,
      data: profileToResponse(profile, rawProfile.lastBriefingAt),
    });
  });
}
