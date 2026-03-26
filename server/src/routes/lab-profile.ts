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
import { env } from '../config/env.js';

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

const updateLabSchema = createLabSchema.partial().extend({
  acknowledgment: z.string().optional(),
  responseStyle: z.string().optional(),
});

const onboardingSchema = z.object({
  homepageUrl: z.string().url().optional(),
  keywords: z.array(z.string()).optional(),
  // 나중에 PDF 업로드 기반 키워드 추출도 지원
});

const memberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  role: z.string().default('학생'),
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

  app.put('/api/lab', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = updateLabSchema.parse(request.body);
    const updated = await prisma.lab.update({
      where: { id: lab.id },
      data: body,
    });
    return updated;
  });

  // ── 온보딩 완료 ────────────────────────────────────
  app.post('/api/lab/onboarding', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = onboardingSchema.parse(request.body);

    let keywords = body.keywords || [];

    // 홈페이지 URL이 제공되면 Gemini로 키워드 추출 시도
    if (body.homepageUrl && keywords.length === 0) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const prompt = `다음 연구실 홈페이지 URL을 보고, 이 연구실의 주요 연구 분야 키워드를 5~10개 추출해주세요.
URL: ${body.homepageUrl}
연구실명: ${lab.name}

JSON 배열로만 응답해주세요. 예: ["biosensor", "flexible electronics", "wearable"]`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const match = text.match(/\[.*\]/s);
        if (match) {
          keywords = JSON.parse(match[0]);
        }
      } catch (err) {
        // 키워드 추출 실패해도 온보딩은 진행
        console.warn('Keyword extraction failed:', err);
      }
    }

    const updated = await prisma.lab.update({
      where: { id: lab.id },
      data: {
        onboardingDone: true,
        researchFields: keywords.length > 0 ? keywords : lab.researchFields,
        homepageUrl: body.homepageUrl || lab.homepageUrl,
      },
    });

    return { lab: updated, extractedKeywords: keywords };
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

  app.post('/api/lab/members', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = memberSchema.parse(request.body);
    const member = await prisma.labMember.create({
      data: { labId: lab.id, ...body },
    });
    return reply.code(201).send(member);
  });

  app.delete('/api/lab/members/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    await prisma.labMember.updateMany({
      where: { id: request.params.id, labId: lab.id },
      data: { active: false },
    });
    return { success: true };
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

  app.post('/api/lab/projects', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = projectSchema.parse(request.body);
    const project = await prisma.project.create({
      data: { labId: lab.id, ...body },
    });
    return reply.code(201).send(project);
  });

  app.put('/api/lab/projects/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = projectSchema.partial().parse(request.body);
    const project = await prisma.project.updateMany({
      where: { id: request.params.id, labId: lab.id },
      data: body,
    });
    return project;
  });

  app.delete('/api/lab/projects/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
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

  app.post('/api/lab/publications', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    const body = publicationSchema.parse(request.body);
    const pub = await prisma.publication.create({
      data: { labId: lab.id, ...body },
    });
    return reply.code(201).send(pub);
  });

  app.delete('/api/lab/publications/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
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

  app.post('/api/lab/dictionary', async (request: FastifyRequest, reply: FastifyReply) => {
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

  app.delete('/api/lab/dictionary/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const lab = await requireLab(request.userId!, reply);
    if (!lab) return;
    await prisma.domainDict.deleteMany({
      where: { id: request.params.id, labId: lab.id },
    });
    return { success: true };
  });
}
