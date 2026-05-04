/**
 * Worksheet Projects Routes — Notion 워크시트 PI ↔ 학생 캐치볼 추적
 *
 * GET    /api/worksheet-projects        → 목록 (whoseTurn별 정렬)
 * POST   /api/worksheet-projects/sync   → 수동 sync 트리거
 * POST   /api/worksheet-projects/:id/remind → 학생에게 Slack DM 리마인드
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { syncWorksheetProjects, getWorksheetProjects } from '../services/worksheet-sync.js';
import { logError } from '../services/error-logger.js';

export async function worksheetProjectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── GET 목록 ─────────────────────────────────────
  app.get('/api/worksheet-projects', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const includeArchived = (request.query as any)?.archived === 'true';
      const items = await getWorksheetProjects({ archived: includeArchived });
      return reply.send({
        items,
        counts: {
          piTurn: items.filter(i => i.whoseTurn === 'PI').length,
          studentTurn: items.filter(i => i.whoseTurn === 'STUDENT').length,
          stale7d: items.filter(i => i.whoseTurn === 'STUDENT' && i.daysSinceTurn >= 7).length,
        },
      });
    } catch (err: any) {
      logError('background', 'GET /api/worksheet-projects 실패', { userId: (request as any).user?.id })(err);
      return reply.code(500).send({ error: '목록 조회 실패' });
    }
  });

  // ── POST 수동 sync ──────────────────────────────
  app.post('/api/worksheet-projects/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await syncWorksheetProjects();
      return reply.send({ ok: true, ...result });
    } catch (err: any) {
      logError('background', 'POST /api/worksheet-projects/sync 실패', { userId: (request as any).user?.id })(err);
      return reply.code(500).send({ error: 'sync 실패', message: err.message });
    }
  });

  // ── POST Slack 리마인드 (수동) ──────────────────
  const remindSchema = z.object({
    studentName: z.string().optional(), // 비우면 모든 담당자에게
    customMessage: z.string().optional(),
  });

  app.post('/api/worksheet-projects/:id/remind', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = remindSchema.parse(request.body || {});

      const project = await prisma.worksheetProject.findUnique({ where: { id } });
      if (!project) return reply.code(404).send({ error: '프로젝트 없음' });

      // 대상 학생: customMessage 가 있으면 그대로, 없으면 daysSinceTurn 기반 자동 메시지
      const targets = body.studentName
        ? [body.studentName]
        : (project.assignees as string[]);

      if (targets.length === 0) {
        return reply.code(400).send({ error: '담당 학생이 없음' });
      }

      const token = env.SLACK_BOT_TOKEN;
      if (!token) return reply.code(500).send({ error: 'SLACK_BOT_TOKEN 미설정' });
      if (!env.LAB_ID) return reply.code(500).send({ error: 'LAB_ID 미설정' });

      const message = body.customMessage || buildDefaultRemindMessage(project, targets);
      const results: Array<{ student: string; ok: boolean; error?: string }> = [];

      for (const studentName of targets) {
        const result = await sendWorksheetRemind(studentName, message, token, env.LAB_ID);
        results.push({ student: studentName, ...result });
      }

      const success = results.filter(r => r.ok).length;
      return reply.send({
        ok: success > 0,
        sent: success,
        total: targets.length,
        results,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      }
      logError('background', 'POST /api/worksheet-projects/:id/remind 실패', { userId: (request as any).user?.id })(err);
      return reply.code(500).send({ error: '리마인드 실패', message: err.message });
    }
  });
}

function buildDefaultRemindMessage(project: any, students: string[]): string {
  const studentList = students.join(', ');
  const lines = [
    `📌 *${project.title} 워크시트 업데이트 요청*`,
    '',
    `${studentList}님, 안녕하세요.`,
    `'${project.title}' 워크시트가 ${project.daysSinceTurn}일째 업데이트가 없습니다.`,
    '',
  ];
  if (project.lastActivitySnippet) {
    lines.push(`마지막 활동: "${project.lastActivitySnippet.slice(0, 80)}"`);
  }
  lines.push(
    '',
    `워크시트 확인: ${project.notionUrl}`,
    '',
    `이 부분에 대한 답변이나 진척 상황을 노션 워크시트에 업데이트 부탁드립니다.`,
  );
  return lines.join('\n');
}

interface SlackResp {
  ok: boolean;
  user?: { id: string };
  error?: string;
}

async function sendWorksheetRemind(
  studentName: string,
  message: string,
  token: string,
  labId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. LabMember에서 이메일 찾기
    const member = await prisma.labMember.findFirst({
      where: {
        labId,
        active: true,
        OR: [{ name: studentName }, { nameEn: studentName }],
      },
      select: { email: true, name: true },
    });

    if (!member?.email) {
      return { ok: false, error: `LabMember 이메일 없음: ${studentName}` };
    }

    // 2. Slack user lookup by email
    const lookup = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(member.email)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then(r => r.json() as Promise<SlackResp>);

    if (!lookup.ok || !lookup.user?.id) {
      return { ok: false, error: lookup.error || `Slack 유저 없음: ${member.email}` };
    }

    // 3. DM 발송
    const post = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: lookup.user.id,
        text: message,
        unfurl_links: false,
        unfurl_media: false,
      }),
    }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>);

    if (!post.ok) return { ok: false, error: post.error || 'chat.postMessage 실패' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
