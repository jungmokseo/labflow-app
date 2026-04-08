/**
 * Lab Profile Routes — 연구실 프로필 + 온보딩 + 구성원 + 과제 + 교정사전
 *
 * GET    /api/lab                    → 현재 사용자의 Lab Profile
 * POST   /api/lab                    → Lab 생성 (온보딩 시작)
 * PUT    /api/lab                    → Lab 업데이트
 * POST   /api/lab/onboarding         → 온보딩 완료 (키워드 추출 포함)
 *
 * GET    /api/lab/members             → 구성원 목록
 * POST   /api/lab/members             → 구성원 추가
 * DELETE /api/lab/members/:id         → 구성원 삭제
 *
 * GET    /api/lab/projects            → 과제 목록
 * POST   /api/lab/projects            → 과제 추가
 * PUT    /api/lab/projects/:id        → 과제 수정
 * DELETE /api/lab/projects/:id        → 과제 삭제
 *
 * GET    /api/lab/publications        → 논문 목록
 * POST   /api/lab/publications        → 논문 추가
 * DELETE /api/lab/publications/:id    → 논문 삭제
 *
 * GET    /api/lab/dictionary          → 교정 사전
 * POST   /api/lab/dictionary          → 교정 사전 항목 추가
 * DELETE /api/lab/dictionary/:id      → 교정 사전 항목 삭제
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { env } from '../config/env.js';
import { analyzeSeedPaper, analyzeSeedPapers, type SeedPaperResult } from '../services/seed-paper.js';
import { syncLabProfileToAllFeatures } from '../services/lab-sync.js';

// ── Zod Schemas ─────────────────────────────────────
const createLabSchema = z.object({
  name: z.string().min(1),
  institution: z.string().optional(),
  department: z.string().optional(),
  piName: z.string().optional(),
  piEmail: z.string().email().optional(),
  researchFields: z.array(z.string()).optional(),
  homepageUrl: z.string().url().optional(),
});

const researchThemeSchema = z.object({
  name: z.string().min(1),
  keywords: z.array(z.string()),
  journals: z.array(z.string()).optional(),
});

const updateLabSchema = createLabSchema.partial().extend({
  acknowledgment: z.string().optional(),
  responseStyle: z.string().optional(),
  instructions: z.string().nullable().optional(),
  researchThemes: z.array(researchThemeSchema).optional(),
});

const onboardingSchema = z.object({
  homepageUrl: z.string().url().optional(),
  keywords: z.array(z.string()).optional(),
  researchThemes: z.array(researchThemeSchema).optional(),
  emailAccounts: z.array(z.object({
    name: z.string(),
    domains: z.array(z.string()),
    emoji: z.string().max(8).default('[mail]'),
  })).optional(),
});

const memberSchema = z.object({
  name: z.string().min(1),
  nameEn: z.string().optional(),
  email: z.string().email().optional(),
  role: z.string().default('학생'),
  permission: z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']).default('VIEWER'),
  team: z.string().optional(),
  phone: z.string().optional(),
});

const projectSchema = z.object({
  name: z.string().min(1),
  number: z.string().optional(),
  funder: z.string().optional(),
  period: z.string().optional(),
  pi: z.string().optional(),
  pm: z.string().optional(),
  acknowledgment: z.string().optional(),
  status: z.string().default('active'),
});

const publicationSchema = z.object({
  title: z.string().min(1),
  journal: z.string().optional(),
  year: z.number().optional(),
  doi: z.string().optional(),
  authors: z.string().optional(),
  projectId: z.string().optional(),
});

const dictSchema = z.object({
  wrongForm: z.string().min(1),
  correctForm: z.string().min(1),
  category: z.string().optional(),
});

// ── Helper: Get or create user's lab ─────────────────
async function getUserLab(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId } });
  if (!user) return null;
  return prisma.lab.findUnique({ where: { ownerId: userId } });
}

async function requireLab(userId: string, reply: FastifyReply) {
  const lab = await getUserLab(userId);
  if (!lab) {
    reply.code(404).send({ error: '연구실이 설정되지 않았습니다. 먼저 /api/lab POST로 생성해주세요.' });
    return null;
  }
  return lab;
}

// ── Routes ───────────────────────────────────────────
export async function labProfileRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── Lab Profile CRUD ──────────────────────────────
  app.get('/api/lab', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({
      where: { ownerId: request.userId! },
      include: {
        members: { where: { active: true }, orderBy: { name: 'asc' } },
        projects: { orderBy: { createdAt: 'desc' } },
        domainDict: { orderBy: { wrongForm: 'asc' } },
        _count: { select: { publications: true, memos: true } },
      },
    });
    if (!lab) {
      return reply.code(404).send({ error: '연구실이 설정되지 않았습니다.' });
    }
    return lab;
  });

  app.post('/api/lab', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createLabSchema.parse(request.body);
    const existing = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (existing) {
      return reply.code(409).send({ error: '이미 연구실이 등록되어 있습니다.' });
    }

    const lab = await prisma.lab.create({
      data: {
        ownerId: request.userId!,
        name: body.name,
        institution: body.institution,
        department: body.department,
        piName: body.piName,
        piEmail: body.piEmail,
        researchFields: body.researchFields || [],
        homepageUrl: body.homepageUrl,
      },
    });
    return reply.code(201).send(lab);
  });

  app.put('/api/lab', { preHandler: requirePermission('ADMIN') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = updateLabSchema.parse(request.body);
    const updated = await prisma.lab.update({
      where: { id: lab.id },
      data: body,
    });

    // Lab 프로필 변경 시 자동 동기화
    syncLabProfileToAllFeatures(request.userId!, lab.id).catch(err =>
      console.warn('Lab sync failed:', err)
    );

    return updated;
  });

  // ── 온보딩 완료 ────────────────────────────────────
  app.post('/api/lab/onboarding', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = onboardingSchema.parse(request.body);

    let keywords = body.keywords || [];
    let researchThemes = body.researchThemes || [];

    // 홈페이지 URL이 제공되면 Gemini로 구조화된 테마 추출 시도
    if (body.homepageUrl && keywords.length === 0 && researchThemes.length === 0) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        const prompt = `다음 연구실 홈페이지를 분석하여, 연구 테마를 구조화해주세요.
URL: ${body.homepageUrl}
연구실명: ${lab.name}
${lab.institution ? `소속: ${lab.institution}` : ''}

다음 JSON 형식으로만 응답:
{
  "keywords": ["keyword1", "keyword2", ...],
  "themes": [
    {"name": "테마명 (한글)", "keywords": ["영문키워드1", "한글키워드1", ...], "journals": ["관련 저널명"]}
  ]
}
themes는 3~5개, keywords는 테마별 3~6개. 한글+영문 혼용.`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          keywords = parsed.keywords || [];
          researchThemes = (parsed.themes || []).map((t: any) => ({
            name: t.name,
            keywords: t.keywords || [],
            journals: t.journals || [],
          }));
        }
      } catch (err) {
        console.warn('Keyword extraction failed:', err);
      }
    }

    const updated = await prisma.lab.update({
      where: { id: lab.id },
      data: {
        onboardingDone: true,
        researchFields: keywords.length > 0 ? keywords : lab.researchFields,
        researchThemes: researchThemes.length > 0 ? researchThemes as any : undefined,
        homepageUrl: body.homepageUrl || lab.homepageUrl,
      },
    });

    // Lab 프로필 → 이메일/논문 알림 자동 동기화
    syncLabProfileToAllFeatures(request.userId!, lab.id).catch(err =>
      console.warn('Lab sync failed:', err)
    );

    return { lab: updated, extractedKeywords: keywords };
  });

  // ── 시드 논문 분석 (온보딩 Step 2) ────────────────
  /**
   * POST /api/lab/seed-paper — 시드 논문 DOI/제목으로 자동 분석
   * Semantic Scholar API + Gemini로 키워드/용어/저널/공저자 추출
   */
  app.post('/api/lab/seed-paper', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;

    const body = z.object({
      papers: z.array(z.string().min(1)).min(1).max(5), // DOI 또는 제목 (1~5개)
    }).parse(request.body);

    // 시드 논문 분석
    const result = await analyzeSeedPapers(body.papers);

    if (result.papers.length === 0) {
      return reply.code(404).send({
        error: '논문을 찾을 수 없습니다. DOI (예: 10.1038/s41467-024-xxxxx) 또는 정확한 논문 제목을 입력해주세요.',
      });
    }

    return result;
  });

  /**
   * POST /api/lab/seed-paper/apply — 분석 결과를 Lab Profile에 적용
   * 키워드, 용어사전, 논문, 저널 목록을 DB에 저장
   */
  app.post('/api/lab/seed-paper/apply', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;

    const body = z.object({
      keywords: z.array(z.string()).optional(),
      terms: z.array(z.object({
        term: z.string(),
        definition: z.string(),
        category: z.string(),
      })).optional(),
      papers: z.array(z.object({
        title: z.string(),
        authors: z.string().optional(),
        journal: z.string().optional(),
        year: z.number().optional(),
        doi: z.string().optional(),
      })).optional(),
      rssKeywords: z.array(z.string()).optional(),
      rssJournals: z.array(z.string()).optional(),
      setupPaperAlert: z.boolean().default(false),
    }).parse(request.body);

    const results: string[] = [];

    // 1. 키워드 → Lab researchFields에 추가 (중복 제거)
    if (body.keywords && body.keywords.length > 0) {
      const merged = [...new Set([...lab.researchFields, ...body.keywords])];
      await prisma.lab.update({
        where: { id: lab.id },
        data: { researchFields: merged },
      });
      results.push(`키워드 ${body.keywords.length}개 추가`);
    }

    // 2. 전문용어 → domainDict에 추가
    if (body.terms && body.terms.length > 0) {
      let added = 0;
      for (const t of body.terms) {
        await prisma.domainDict.upsert({
          where: { labId_wrongForm: { labId: lab.id, wrongForm: t.term.toLowerCase() } },
          create: {
            labId: lab.id,
            wrongForm: t.term.toLowerCase(),
            correctForm: t.term, // 정확한 대소문자 표기
            category: t.category,
          },
          update: {},
        }).catch(() => {});
        added++;
      }
      results.push(`전문용어 ${added}개 추가`);
    }

    // 3. 논문 → publications에 추가
    if (body.papers && body.papers.length > 0) {
      for (const p of body.papers) {
        await prisma.publication.create({
          data: {
            labId: lab.id,
            title: p.title,
            authors: p.authors,
            journal: p.journal,
            year: p.year,
            doi: p.doi,
          },
        }).catch(() => {});
      }
      results.push(`논문 ${body.papers.length}편 등록`);
    }

    // 4. 논문 알림 자동 설정
    if (body.setupPaperAlert && body.rssKeywords && body.rssKeywords.length > 0) {
      const existing = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
      if (existing) {
        const mergedKw = [...new Set([...existing.keywords, ...body.rssKeywords])];
        await prisma.paperAlert.update({
          where: { id: existing.id },
          data: { keywords: mergedKw },
        });
      } else {
        await prisma.paperAlert.create({
          data: {
            labId: lab.id,
            keywords: body.rssKeywords,
            journals: body.rssJournals || [],
            schedule: 'weekly',
          },
        });
      }
      results.push(`논문 알림 설정 완료 (${body.rssKeywords.length}개 키워드)`);
    }

    // 5. 온보딩 완료 표시
    await prisma.lab.update({
      where: { id: lab.id },
      data: { onboardingDone: true },
    });

    return { success: true, applied: results };
  });

  /**
   * GET /api/lab/completeness — 프로필 완성도 계산
   */
  app.get('/api/lab/completeness', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({
      where: { ownerId: request.userId! },
      include: {
        _count: {
          select: { members: true, projects: true, publications: true, domainDict: true, memos: true },
        },
      },
    });

    if (!lab) {
      return reply.code(404).send({ error: '연구실이 설정되지 않았습니다.' });
    }

    const checks = [
      { item: '연구실명', done: !!lab.name, weight: 15 },
      { item: 'PI 이름', done: !!lab.piName, weight: 10 },
      { item: '소속 기관', done: !!lab.institution, weight: 5 },
      { item: '연구 분야', done: lab.researchFields.length > 0, weight: 15 },
      { item: '구성원', done: lab._count.members > 0, weight: 15 },
      { item: '과제', done: lab._count.projects > 0, weight: 10 },
      { item: '논문', done: lab._count.publications > 0, weight: 10 },
      { item: '전문용어 사전', done: lab._count.domainDict > 0, weight: 10 },
      { item: '메모', done: lab._count.memos > 0, weight: 5 },
      { item: '홈페이지', done: !!lab.homepageUrl, weight: 5 },
    ];

    const completed = checks.filter(c => c.done).reduce((sum, c) => sum + c.weight, 0);
    const missing = checks.filter(c => !c.done);

    return {
      percentage: completed,
      checks,
      missingItems: missing.map(m => m.item),
      suggestions: missing.slice(0, 3).map(m => {
        switch (m.item) {
          case '구성원': return '구성원 정보를 추가해보세요. 대화로도 가능해요: "김태영 박사과정 추가해줘"';
          case '과제': return '진행 중인 연구과제를 등록해보세요. 사사 문구 조회에 필요합니다.';
          case '전문용어 사전': return '대표 논문 DOI를 입력하면 전문용어가 자동으로 추출됩니다.';
          case '연구 분야': return '대표 논문 DOI를 입력하면 연구 분야 키워드가 자동 추출됩니다.';
          default: return `${m.item}을(를) 등록해보세요.`;
        }
      }),
    };
  });

  // ── Members CRUD ──────────────────────────────────
  app.get('/api/lab/members', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    return prisma.labMember.findMany({
      where: { labId: lab.id, active: true },
      orderBy: { name: 'asc' },
    });
  });

  app.post('/api/lab/members', { preHandler: requirePermission('ADMIN') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = memberSchema.parse(request.body);
    const member = await prisma.labMember.create({
      data: { labId: lab.id, ...body },
    });
    return reply.code(201).send(member);
  });

  app.delete<{ Params: { id: string } }>('/api/lab/members/:id', { preHandler: requirePermission('ADMIN') }, async (request, reply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    await prisma.labMember.updateMany({
      where: { id: request.params.id, labId: lab.id },
      data: { active: false },
    });
    return { success: true };
  });

  // ── PUT /api/lab/members/:id — 멤버 정보 수정 ──────
  app.put<{ Params: { id: string } }>('/api/lab/members/:id', { preHandler: requirePermission('ADMIN') }, async (request, reply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = memberSchema.partial().parse(request.body);
    const updated = await prisma.labMember.update({
      where: { id: request.params.id },
      data: body,
    });
    return updated;
  });

  // ── POST /api/lab/members/join — 초대된 멤버가 계정 연결 ──
  app.post('/api/lab/members/join', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const body = z.object({
      labId: z.string(),
      email: z.string().email(),
    }).parse(request.body);

    // 해당 Lab에서 이메일로 초대된 멤버를 찾기
    const member = await prisma.labMember.findFirst({
      where: {
        labId: body.labId,
        email: body.email,
        active: true,
        userId: null, // 아직 연결 안 된 멤버만
      },
    });

    if (!member) {
      return reply.code(404).send({
        error: '초대된 멤버를 찾을 수 없습니다. PI에게 이메일로 초대를 요청해주세요.',
      });
    }

    // 유저 ID 연결
    const updated = await prisma.labMember.update({
      where: { id: member.id },
      data: { userId },
    });

    return { success: true, member: updated };
  });

  // ── GET /api/lab/my-permission — 현재 유저의 권한 확인 ──
  app.get('/api/lab/my-permission', async (request: FastifyRequest, reply: FastifyReply) => {
    return {
      permission: request.labPermission || null,
      labId: request.labId || null,
    };
  });

  // ── POST /api/lab/members/fetch-en-names — 홈페이지에서 영문 이름 자동 추출 ──
  app.post('/api/lab/members/fetch-en-names', { preHandler: requirePermission('ADMIN') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;

    const labData = await prisma.lab.findUnique({ where: { id: lab.id }, select: { homepageUrl: true } });
    if (!labData?.homepageUrl) return reply.code(400).send({ error: '연구실 홈페이지 URL이 설정되어 있지 않습니다.' });

    // Fetch homepage content
    let pageText = '';
    try {
      const res = await fetch(labData.homepageUrl, { signal: AbortSignal.timeout(10000) });
      pageText = await res.text();
    } catch {
      return reply.code(502).send({ error: '홈페이지에 접속할 수 없습니다.' });
    }

    // Get current members
    const members = await prisma.labMember.findMany({
      where: { labId: lab.id, active: true },
      select: { id: true, name: true, nameEn: true },
    });
    const membersWithoutEn = members.filter(m => !m.nameEn);
    if (membersWithoutEn.length === 0) return reply.send({ updated: 0, message: '모든 멤버의 영문 이름이 이미 등록되어 있습니다.' });

    // Use Gemini to match Korean names to English names from the page
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const { env } = await import('../config/env.js');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `아래 웹페이지 HTML에서 연구실 멤버들의 영문 이름을 찾아주세요.

멤버 목록 (한국어 이름):
${membersWithoutEn.map(m => `- ${m.name}`).join('\n')}

웹페이지 내용 (HTML):
${pageText.slice(0, 30000)}

각 한국어 이름에 대응하는 영문 이름을 찾아 JSON 배열로만 응답하세요. 찾을 수 없는 경우 null:
[{"name": "한국어이름", "nameEn": "English Name" | null}]`;

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      });
      const text = result.response.text().trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return reply.code(500).send({ error: '영문 이름 추출 실패' });

      const mappings: Array<{ name: string; nameEn: string | null }> = JSON.parse(match[0]);
      let updated = 0;
      for (const mapping of mappings) {
        if (!mapping.nameEn) continue;
        const member = membersWithoutEn.find(m => m.name === mapping.name);
        if (member) {
          await prisma.labMember.update({ where: { id: member.id }, data: { nameEn: mapping.nameEn } });
          updated++;
        }
      }
      return reply.send({ updated, mappings });
    } catch (err: any) {
      return reply.code(500).send({ error: '영문 이름 추출 실패', details: err.message });
    }
  });

  // ── Projects CRUD ─────────────────────────────────
  app.get('/api/lab/projects', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    return prisma.project.findMany({
      where: { labId: lab.id },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.post('/api/lab/projects', { preHandler: requirePermission('EDITOR') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = projectSchema.parse(request.body);
    const project = await prisma.project.create({
      data: { labId: lab.id, ...body },
    });
    return reply.code(201).send(project);
  });

  app.put<{ Params: { id: string } }>('/api/lab/projects/:id', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = projectSchema.partial().parse(request.body);
    const project = await prisma.project.updateMany({
      where: { id: request.params.id, labId: lab.id },
      data: body,
    });
    return project;
  });

  app.delete<{ Params: { id: string } }>('/api/lab/projects/:id', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    await prisma.project.deleteMany({
      where: { id: request.params.id, labId: lab.id },
    });
    return { success: true };
  });

  // ── Publications CRUD ──────────────────────────────
  app.get('/api/lab/publications', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    return prisma.publication.findMany({
      where: { labId: lab.id },
      orderBy: { year: 'desc' },
    });
  });

  app.post('/api/lab/publications', { preHandler: requirePermission('EDITOR') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = publicationSchema.parse(request.body);
    const pub = await prisma.publication.create({
      data: { labId: lab.id, ...body },
    });
    return reply.code(201).send(pub);
  });

  app.delete<{ Params: { id: string } }>('/api/lab/publications/:id', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    await prisma.publication.deleteMany({
      where: { id: request.params.id, labId: lab.id },
    });
    return { success: true };
  });

  // ── Domain Dictionary CRUD ─────────────────────────
  app.get('/api/lab/dictionary', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    return prisma.domainDict.findMany({
      where: { labId: lab.id },
      orderBy: { wrongForm: 'asc' },
    });
  });

  app.post('/api/lab/dictionary', { preHandler: requirePermission('EDITOR') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = dictSchema.parse(request.body);
    const entry = await prisma.domainDict.upsert({
      where: { labId_wrongForm: { labId: lab.id, wrongForm: body.wrongForm } },
      create: { labId: lab.id, ...body },
      update: { correctForm: body.correctForm, category: body.category },
    });
    return reply.code(201).send(entry);
  });

  app.delete<{ Params: { id: string } }>('/api/lab/dictionary/:id', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    await prisma.domainDict.deleteMany({
      where: { id: request.params.id, labId: lab.id },
    });
    return { success: true };
  });
}
