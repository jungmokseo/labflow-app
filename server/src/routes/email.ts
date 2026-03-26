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
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';

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
  emoji: z.string().max(4).default('📧'),
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

// ── 카테고리 이모지 매핑 (고정 — 출력 포맷) ──────────
const CATEGORY_EMOJI: Record<EmailCategory, string> = {
  'urgent': '⚠️',
  'action-needed': '📝',
  'schedule': '📅',
  'info': '📰',
  'ads': '🛒',
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
- "개인" (👤): 위 그룹에 해당하지 않는 모든 메일

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
| urgent | ⚠️ | 마감 24시간 이내 또는 즉각 조치 필요 |
| action-needed | 📝 | 의견·결정·승인 요청, 명시적 회신 요청 |
| schedule | 📅 | 날짜/시간이 포함된 이벤트, 마감일, 미팅, 캘린더 초대 |
| info | 📰 | 공지, 뉴스레터, 알림, 단순 CC 수신, 처리 완료 보고 |
| ads | 🛒 | 마케팅 광고, 프로모션, 할인, 구독 권유 |
${groupInstruction}

## 중요도 조정 규칙
${keywordSection}${importanceSection}

## 본문 열람 판단
각 이메일에 "needsBody" (boolean) 필드를 추가:
- urgent / action-needed → true
- schedule → snippet이 불명확한 경우만 true
- info / ads → false

## 요약 규칙
- ⚠️/📝: 핵심 내용 + 조치사항(→) 1줄. 최대 3줄.
- 📅: 이벤트명 + 날짜/시간.
- 📰: 발신자 — 한 줄 요약.
- 🛒: 발신자 + 제목만.
- 같은 스레드의 여러 메일은 하나로 합쳐 최신 상태로 요약.`;
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
    // fallback — Sonnet 미설정 시 기본 info
    emails.forEach((e) => {
      results.set(String(e.index), {
        category: 'info',
        confidence: 0.5,
        summary: e.subject.substring(0, 50),
        needsBody: false,
      });
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
    console.warn('⚠️ Sonnet 분류 실패:', error);
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
    // Google 리다이렉트는 custom header 불가 → state 파라미터에서 userId 추출
    const userId = query.state || 'dev-user-001';
    try {
      const oauth2Client = createOAuth2Client();
      const { tokens } = await oauth2Client.getToken(query.code);
      const user = await ensureUser(userId);

      await prisma.gmailToken.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          accessToken: tokens.access_token!,
          refreshToken: tokens.refresh_token || null,
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        },
        update: {
          accessToken: tokens.access_token!,
          refreshToken: tokens.refresh_token || undefined,
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        },
      });

      // 성공: 앱으로 리다이렉트 또는 성공 페이지 표시
      if (env.NODE_ENV === 'development') {
        return reply.redirect('http://localhost:8081');
      }
      // Production: 성공 HTML 페이지 (deep link 시도 + fallback)
      return reply.type('text/html').send(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>LabFlow - Gmail 연동 완료</title>
        <style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e0e0e0}
        .card{text-align:center;padding:2rem;border-radius:16px;background:#1a1a2e;max-width:400px}
        .icon{font-size:64px;margin-bottom:1rem}h1{color:#4ade80;font-size:1.5rem}p{color:#999;line-height:1.6}</style></head>
        <body><div class="card"><div class="icon">✅</div><h1>Gmail 연동 완료!</h1>
        <p>LabFlow 앱으로 돌아가서<br>이메일 브리핑을 확인하세요.</p></div></body></html>
      `);
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
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        state: request.userId,
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
      const user = await prisma.user.findFirst({ where: { clerkId: userId } });
      if (!user) return reply.send({ success: true, connected: false });

      const gmailToken = await prisma.gmailToken.findUnique({ where: { userId: user.id } });
      if (!gmailToken) return reply.send({ success: true, connected: false });

      const isExpired = gmailToken.expiresAt && gmailToken.expiresAt < new Date();
      const rawProfile = await prisma.emailProfile.findUnique({ where: { userId: user.id } });

      return reply.send({
        success: true,
        connected: !isExpired,
        expiresAt: gmailToken.expiresAt?.toISOString() || null,
        hasProfile: !!rawProfile,
        classifyByGroup: rawProfile?.classifyByGroup ?? false,
        groupCount: rawProfile ? (rawProfile.groups as any[]).length : 0,
        lastBriefingAt: rawProfile?.lastBriefingAt?.toISOString() || null,
        message: isExpired ? 'Gmail 토큰 만료' : 'Gmail 정상 연동',
      });
    } catch (error: any) {
      return reply.code(500).send({ error: 'Gmail 상태 확인 실패', details: error.message });
    }
  });

  // ── GET /api/email/profile ──────────────────────
  app.get('/api/email/profile', async (request, reply) => {
    const userId = request.userId!;
    const user = await prisma.user.findFirst({ where: { clerkId: userId } });
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
      const user = await prisma.user.findFirst({ where: { clerkId: userId } });
      if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

      const gmailToken = await prisma.gmailToken.findUnique({ where: { userId: user.id } });
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

      // T_last 결정: query.since > profile.lastBriefingAt > 오늘 0시
      let afterDate: Date;
      if (query.since) {
        afterDate = new Date(query.since);
      } else if (rawProfile?.lastBriefingAt) {
        afterDate = rawProfile.lastBriefingAt;
      } else {
        const now = new Date();
        afterDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }

      // Gmail 검색 쿼리 구성
      const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
      const excludeSpam = query.includeSpam === 'false'
        ? '-category:promotions -category:social'
        : '';

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: gmailToken.accessToken,
        refresh_token: gmailToken.refreshToken || undefined,
        expiry_date: gmailToken.expiresAt?.getTime(),
      });
      // 토큰 자동 갱신 시 DB 업데이트
      oauth2Client.on('tokens', async (tokens) => {
        try {
          await prisma.gmailToken.update({
            where: { userId: user!.id },
            data: {
              accessToken: tokens.access_token!,
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
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
          group: cls.group,
          groupEmoji: cls.groupEmoji,
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
}
