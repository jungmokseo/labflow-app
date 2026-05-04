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
import {
  recordWorksheetReminder,
  checkPendingReminders,
  getRemindersByProject,
  getRemindersForStudent,
} from '../services/worksheet-reminder.js';
import { logError } from '../services/error-logger.js';

export async function worksheetProjectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── GET 목록 ─────────────────────────────────────
  app.get('/api/worksheet-projects', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const includeArchived = (request.query as any)?.archived === 'true';
      const items = await getWorksheetProjects({ archived: includeArchived });

      // 모든 프로젝트의 reminder stats를 단 하나의 SQL aggregate로 — 14 API call 제거
      // 각 ProjectCard가 mount 시 개별 fetch하던 것을 부모 응답에 포함.
      const ids = items.map(i => i.id);
      let statsByProject: Record<string, { sent: number; acked: number; lastSentAt: string | null }> = {};
      if (ids.length > 0) {
        try {
          const rows = await prisma.$queryRawUnsafe<Array<{
            project_id: string;
            sent_count: bigint;
            acked_count: bigint;
            last_sent_at: Date | null;
          }>>(
            `SELECT project_id,
                    COUNT(*)::bigint as sent_count,
                    COUNT(acked_at)::bigint as acked_count,
                    MAX(sent_at) as last_sent_at
             FROM worksheet_reminders
             WHERE project_id = ANY($1::text[])
               AND dismissed_at IS NULL
             GROUP BY project_id`,
            ids,
          );
          for (const row of rows) {
            statsByProject[row.project_id] = {
              sent: Number(row.sent_count),
              acked: Number(row.acked_count),
              lastSentAt: row.last_sent_at ? row.last_sent_at.toISOString() : null,
            };
          }
        } catch { /* worksheet_reminders 테이블 없으면 빈 stats */ }
      }

      const enriched = items.map(i => ({
        ...i,
        reminderStats: statsByProject[i.id] || { sent: 0, acked: 0, lastSentAt: null },
      }));

      return reply.send({
        items: enriched,
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
      const purpose: 'PI_TURN' | 'STUDENT_TURN' = project.whoseTurn === 'PI' ? 'STUDENT_TURN' : 'PI_TURN';
      const sentBy = (request as any).user?.id as string | undefined;
      const results: Array<{ student: string; ok: boolean; error?: string; reminderId?: string }> = [];

      for (const studentName of targets) {
        // 1. LabMember 이메일 → Slack user_id lookup
        const member = await prisma.labMember.findFirst({
          where: { labId: env.LAB_ID, active: true, OR: [{ name: studentName }, { nameEn: studentName }] },
          select: { email: true },
        });
        if (!member?.email) {
          results.push({ student: studentName, ok: false, error: `LabMember 이메일 없음: ${studentName}` });
          continue;
        }
        const lookup = await fetch(
          `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(member.email)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ).then(r => r.json() as Promise<{ ok: boolean; user?: { id: string }; error?: string }>);
        if (!lookup.ok || !lookup.user?.id) {
          results.push({ student: studentName, ok: false, error: lookup.error || 'Slack 유저 없음' });
          continue;
        }

        // 2. recordWorksheetReminder — Slack DM 발송 + DB row 생성 (✅ reaction 추적용)
        const r = await recordWorksheetReminder({
          projectId: project.id,
          projectTitle: project.title,
          studentName,
          slackUserId: lookup.user.id,
          message,
          purpose,
          sentByUserId: sentBy,
        });
        results.push({ student: studentName, ok: r.ok, error: r.error, reminderId: r.reminderId });
      }

      const success = results.filter(r => r.ok).length;

      // PI 차례에서 발송 성공 → 즉시 학생 차례로 전환.
      // (PI가 노션에 답변 코멘트 단 후 클릭하는 흐름이라, 메시지 발송 = 검토 완료 시그널)
      // 다음 매시간 sync에서 노션의 실제 timeline으로 자동 재조정.
      if (success > 0 && project.whoseTurn === 'PI') {
        await prisma.worksheetProject.update({
          where: { id: project.id },
          data: {
            whoseTurn: 'STUDENT',
            lastActivityAt: new Date(),
            lastActivityRole: 'PI',
            lastActivityByName: 'PI (Slack 알림 발송)',
            daysSinceTurn: 0,
          },
        });
      }

      return reply.send({
        ok: success > 0,
        sent: success,
        total: targets.length,
        results,
        // UI가 즉시 차례 전환을 반영할 수 있도록 명시
        turnChanged: success > 0 && project.whoseTurn === 'PI',
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      }
      logError('background', 'POST /api/worksheet-projects/:id/remind 실패', { userId: (request as any).user?.id })(err);
      return reply.code(500).send({ error: '리마인드 실패', message: err.message });
    }
  });

  // ── GET 프로젝트별 reminder 목록 ─────────────────
  app.get('/api/worksheet-projects/:id/reminders', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const items = await getRemindersByProject(id);
      return reply.send({ items });
    } catch (err: any) {
      return reply.code(500).send({ error: '조회 실패', message: err.message });
    }
  });

  // ── POST reactions 폴링 — 발송된 reminder 중 ✅ 반응 받은 것 ackedAt 갱신 ─
  app.post('/api/worksheet-projects/check-acks', async (_request, reply) => {
    try {
      const result = await checkPendingReminders();
      return reply.send(result);
    } catch (err: any) {
      return reply.code(500).send({ error: 'check-acks 실패', message: err.message });
    }
  });

  // ── GET 학생별 pending reminder (App Home에서 호출, X-Slack-Relay-Secret 인증) ─
  app.get('/api/worksheet-projects/student/:slackUserId/reminders', async (request, reply) => {
    try {
      const headerSecret = request.headers['x-slack-relay-secret'] as string | undefined;
      if (!env.SLACK_RELAY_SECRET || headerSecret !== env.SLACK_RELAY_SECRET) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const { slackUserId } = request.params as { slackUserId: string };
      const includeAcked = (request.query as any)?.includeAcked === 'true';
      const items = await getRemindersForStudent(slackUserId, includeAcked);
      return reply.send({ items });
    } catch (err: any) {
      return reply.code(500).send({ error: '학생 reminder 조회 실패', message: err.message });
    }
  });
}

function buildDefaultRemindMessage(project: any, students: string[]): string {
  const studentList = students.join(', ');

  // PI 차례 = PI가 학생 답변을 검토하고 새 코멘트를 남긴 후 학생에게 알리는 케이스.
  // 학생 차례 = 학생이 응답해야 하는데 N일 동안 안 한 케이스.
  const isPiTurn = project.whoseTurn === 'PI';

  if (isPiTurn) {
    const lines = [
      `📋 *${project.title} — 검토 완료, 다음 단계 진행 부탁*`,
      '',
      `${studentList}님,`,
      `'${project.title}' 워크시트에 PI 검토 코멘트가 추가되었습니다.`,
      '',
    ];
    if (project.lastActivitySnippet) {
      lines.push(`최근 메모: "${project.lastActivitySnippet.slice(0, 80)}"`);
      lines.push('');
    }
    lines.push(
      `워크시트 확인: ${project.notionUrl}`,
      '',
      `노션에서 새 코멘트를 확인하시고 다음 단계 진행해 주세요.`,
    );
    return lines.join('\n');
  }

  // 학생 차례 — 응답 대기
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

// sendWorksheetRemind 옛 helper는 worksheet-reminder.ts의 recordWorksheetReminder로 대체됨.
// 아래는 deprecated 한 잔여 구현으로 더 이상 사용되지 않음 (혹시 다른 import 있으면 컴파일 에러 잡힐 것).
async function _legacySendWorksheetRemind_DEPRECATED(
  studentName: string,
  message: string,
  token: string,
  labId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const member = await prisma.labMember.findFirst({
      where: { labId, active: true, OR: [{ name: studentName }, { nameEn: studentName }] },
      select: { email: true, name: true },
    });
    if (!member?.email) return { ok: false, error: `LabMember 이메일 없음: ${studentName}` };
    const lookup = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(member.email)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then(r => r.json() as Promise<{ ok: boolean; user?: { id: string }; error?: string }>);
    if (!lookup.ok || !lookup.user?.id) return { ok: false, error: lookup.error || `Slack 유저 없음: ${member.email}` };
    const post = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: lookup.user.id, text: message, unfurl_links: false, unfurl_media: false }),
    }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>);

    if (!post.ok) return { ok: false, error: post.error || 'chat.postMessage 실패' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
