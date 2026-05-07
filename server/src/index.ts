/**
 * LabFlow API Server
 *
 * Fastify + Prisma + Supabase PostgreSQL + Gemini Flash
 * 캡처 CRUD, AI 자동분류, Supabase 인증
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { captureRoutes } from './routes/captures.js';
import { emailCallbackRoute, emailRoutes } from './routes/email.js';
import { meetingRoutes } from './routes/meetings.js';
import { voiceChatbotRoutes } from './routes/voice-chatbot.js';
import { knowledgeGraphRoutes } from './routes/knowledge-graph.js';
import { resetRoutes } from './routes/reset.js';
import { brainRoutes, archiveOldSessions } from './routes/brain.js';
import { labProfileRoutes } from './routes/lab-profile.js';
import { paperAlertRoutes, startPaperAlertCron } from './routes/paper-alerts.js';
import { startWeeklyBriefingCron } from './services/weekly-briefing.js';
import { paperRoutes } from './routes/papers.js';
import { labCaptureRoutes } from './routes/lab-captures.js';
import { briefingRoutes } from './routes/briefing.js';
import { calendarRoutes } from './routes/calendar.js';
import { errorRoutes } from './routes/errors.js';
import { wikiRoutes } from './routes/wiki.js';
import { syncRoutes } from './routes/sync.js';
import { blissTasksRoutes } from './routes/bliss-tasks.js';
import { followUpRoutes } from './routes/follow-up.js';
import { labDataRoutes } from './routes/lab-data.js';
import { inboxSummaryRoutes } from './routes/inbox-summary.js';
import { worksheetProjectRoutes } from './routes/worksheet-projects.js';
import { syncWorksheetProjects } from './services/worksheet-sync.js';
import { checkPendingReminders } from './services/worksheet-reminder.js';
import { manuscriptRoutes } from './routes/manuscripts.js';
import { syncManuscripts } from './services/manuscript-sync.js';
import { monitorManuscriptMail } from './services/manuscript-mail-monitor.js';
import { syncVacationsToCalendar } from './services/vacation-calendar-sync.js';
import { grantRoutes } from './routes/grants.js';
import { automationRoutes } from './routes/automations.js';
import { setupRequestContextHook } from './middleware/auth.js';
import { resolveLabPermission } from './middleware/permissions.js';
import { syncAllGdriveData } from './services/gdrive-sync.js';
import { enqueueNewData, ingestAndCompile, deepSynthesis } from './services/wiki-engine.js';
import { prisma } from './config/prisma.js';

async function buildApp() {
    const app = Fastify({
          logger: {
                  level: env.NODE_ENV === 'development' ? 'info' : 'warn',
                  transport: env.NODE_ENV === 'development'
                    ? { target: 'pino-pretty', options: { colorize: true } }
                            : undefined,
          },
    });

  // ── 플러그인 ──────────────────────────────────────
  const corsOrigins = env.CORS_ORIGINS.trim();
  await app.register(cors, {
        origin: corsOrigins === '*' ? true : corsOrigins.split(',').map(s => s.trim()),
        credentials: corsOrigins !== '*',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Dev-User-Id'],
  });
    await app.register(multipart, {
          limits: { fileSize: 55 * 1024 * 1024 }, // 55MB (긴 회의 오디오 대응; 개별 라우트에서 추가 제한)
    });
    await app.register(sensible);

  // ── 글로벌 에러 핸들링 ────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
        // Zod 유효성 검증 에러
                          if (error.name === 'ZodError') {
                                  return reply.code(400).send({
                                            error: '입력값이 올바르지 않습니다',
                                            details: JSON.parse(error.message),
                                  });
                          }

                          // 그 외 에러
                          app.log.error(error);
        return reply.code(error.statusCode ?? 500).send({
                error: error.message || '서버 오류가 발생했습니다',
        });
  });

  // ── Data isolation context hook ────────────────────
  setupRequestContextHook(app);

  // ── Lab 권한 해석 (auth + context 후에 실행) ──────
  app.addHook('onRequest', resolveLabPermission);

  // ── 라우트 등록 ────────────────────────────────────
  await app.register(healthRoutes);
    await app.register(captureRoutes);
    await app.register(emailCallbackRoute);  // auth 없는 OAuth 콜백 (반드시 emailRoutes보다 먼저)
  await app.register(emailRoutes);
    await app.register(meetingRoutes);
    await app.register(voiceChatbotRoutes);
    await app.register(knowledgeGraphRoutes);
    await app.register(resetRoutes);
    await app.register(brainRoutes);
    await app.register(labProfileRoutes);
    await app.register(paperAlertRoutes);
    await app.register(paperRoutes);
    await app.register(labCaptureRoutes);
    await app.register(briefingRoutes);
    await app.register(calendarRoutes);
    await app.register(errorRoutes);
    await app.register(wikiRoutes);
    await app.register(syncRoutes);
    await app.register(blissTasksRoutes);
    await app.register(followUpRoutes);
    await app.register(labDataRoutes);
    await app.register(inboxSummaryRoutes);
    await app.register(worksheetProjectRoutes);
    await app.register(manuscriptRoutes);
    await app.register(grantRoutes);
    await app.register(automationRoutes);

  return app;
}

// ── 서버 시작 ──────────────────────────────────────
async function start() {
    try {
          const app = await buildApp();
          await app.listen({ port: env.PORT, host: env.HOST });

      // 논문 알림 cron + 세션 아카이브 + 주간 브리핑 (매주 월요일 09:00 KST)
      startPaperAlertCron();
      startWeeklyBriefingCron();
      setInterval(() => archiveOldSessions().catch((err) => console.error('[background] archiveOldSessions:', err.message || err)), 24 * 60 * 60 * 1000);

      // ── 워크시트 sync 크론 + reminder ack 폴링 ─────────────────────────
      // - 워크시트 sync: Notion 캐치볼 추적
      // - Reminder ack: Slack reactions.get으로 ✅ 받은 reminder 갱신
      if (env.NOTION_API_KEY) {
        const runSyncAndCheck = async () => {
          try { await syncWorksheetProjects(); }
          catch (e: any) { console.error('[worksheet-cron] sync 실패:', e.message); }
          if (env.SLACK_BOT_TOKEN) {
            try {
              const r = await checkPendingReminders();
              if (r.acked > 0) console.log(`[worksheet-cron] reminder ack: ${r.acked}/${r.checked}`);
            } catch (e: any) { console.error('[worksheet-cron] reminder check 실패:', e.message); }
          }
        };
        setTimeout(runSyncAndCheck, 60000);  // 시작 60초 후 1회
        setInterval(runSyncAndCheck, 60 * 60 * 1000);  // 매시간
        console.log('[worksheet-cron] 워크시트 sync + reminder ack 폴링 예약됨 (1시간 주기)');

        // 논문 파이프라인:
        // - sync (노션→DB): 매시간 (UI 갱신 빠르게)
        // - Gmail 자동 감지: 하루 1회 + incremental (last receivedAt 이후만 — AI 미사용이지만 사용자 선호 따름)
        const runManuscriptSync = async () => {
          try { await syncManuscripts(); }
          catch (e: any) { console.error('[manuscript-cron] sync 실패:', e.message); }
        };
        const runManuscriptMail = async () => {
          try {
            const r = await monitorManuscriptMail({ userId: '' });  // daysAgo 미지정 → incremental
            if (r.scanned > 0) console.log(`[manuscript-cron] mail scan: ${r.scanned} (matched ${r.matched})`);
          } catch (e: any) { console.error('[manuscript-cron] mail monitor 실패:', e.message); }
        };
        setTimeout(runManuscriptSync, 90000);
        setInterval(runManuscriptSync, 60 * 60 * 1000);  // 매시간 sync
        setTimeout(runManuscriptMail, 120000);  // 시작 2분 후 1회
        setInterval(runManuscriptMail, 24 * 60 * 60 * 1000);  // 하루 1회 Gmail 감지
        console.log('[manuscript-cron] 노션 sync 1h + Gmail 감지 24h (incremental) 예약됨');

        // 휴가 → BLISS Lab Google Calendar 자동 등록 (매시간)
        const runVacationCalendarSync = async () => {
          try {
            const r = await syncVacationsToCalendar();
            if (r.created > 0 || r.cancelled > 0) {
              console.log(`[vacation-cron] 캘린더 등록: 신규 ${r.created} / 취소 ${r.cancelled}`);
            }
          } catch (e: any) {
            console.error('[vacation-cron] FAILED:', e.message);
          }
        };
        setTimeout(runVacationCalendarSync, 150000);  // 시작 2.5분 후 1회
        setInterval(runVacationCalendarSync, 60 * 60 * 1000);  // 매시간
        console.log('[vacation-cron] 휴가 → 캘린더 자동 등록 예약됨 (1시간 주기)');
      }

      // GDrive 자동 동기화 (LAB_ID + GOOGLE_REFRESH_TOKEN + 파일 ID 중 1개 이상 설정된 경우)
      if (env.LAB_ID && env.GOOGLE_REFRESH_TOKEN && (env.GDRIVE_FILE_ACCOUNTS || env.GDRIVE_FILE_PROJECT_INFO || env.GDRIVE_FILE_ACKNOWLEDGMENT || env.GDRIVE_FILE_MEMBER_INFO)) {
        // 서버 시작 10초 후 1회 동기화
        setTimeout(async () => {
          try {
            console.log('[gdrive-cron] 시작 동기화 실행...');
            await syncAllGdriveData(env.LAB_ID!);
            console.log('[gdrive-cron] 시작 동기화 완료');
          } catch (e: any) {
            console.error('[gdrive-cron] 시작 동기화 실패:', e.message);
          }
        }, 10000);

        // 매 24시간마다 동기화
        setInterval(async () => {
          try {
            console.log('[gdrive-cron] 정기 동기화 실행...');
            await syncAllGdriveData(env.LAB_ID!);
            console.log('[gdrive-cron] 정기 동기화 완료');
          } catch (e: any) {
            console.error('[gdrive-cron] 정기 동기화 실패:', e.message);
          }
        }, 24 * 60 * 60 * 1000);

        console.log('[gdrive-cron] GDrive 자동 동기화 예약됨 (24시간 주기)');
      }

      // ── Wiki 자동 합성 크론 ──────────────────────────────
      if (env.LAB_ID && env.ANTHROPIC_API_KEY) {
        // 서버 시작 30초 후 ingest 1회
        setTimeout(async () => {
          try {
            const lab = await prisma.lab.findUnique({ where: { id: env.LAB_ID! } });
            if (!lab) return;
            const owner = await prisma.user.findUnique({ where: { id: lab.ownerId } });
            if (!owner) return;
            await enqueueNewData(env.LAB_ID!, owner.id);
            await ingestAndCompile(env.LAB_ID!);
            console.log('[wiki-cron] 시작 인제스트 완료');
          } catch (e: any) { console.error('[wiki-cron] 시작 인제스트 실패:', e.message); }
        }, 30000);

        // 24시간마다 ingest
        setInterval(async () => {
          try {
            const lab = await prisma.lab.findUnique({ where: { id: env.LAB_ID! } });
            if (!lab) return;
            const owner = await prisma.user.findUnique({ where: { id: lab.ownerId } });
            if (!owner) return;
            await enqueueNewData(env.LAB_ID!, owner.id);
            await ingestAndCompile(env.LAB_ID!);
            console.log('[wiki-cron] 정기 인제스트 완료');
          } catch (e: any) { console.error('[wiki-cron] 인제스트 실패:', e.message); }
        }, 24 * 60 * 60 * 1000);

        // 7일마다 Opus deep synthesis
        setInterval(async () => {
          try {
            await deepSynthesis(env.LAB_ID!);
            console.log('[wiki-cron] Deep synthesis 완료');
          } catch (e: any) { console.error('[wiki-cron] Deep synthesis 실패:', e.message); }
        }, 7 * 24 * 60 * 60 * 1000);

        console.log('[wiki-cron] Wiki 자동 합성 예약됨 (24h ingest / 7d synthesis)');
      }

      // ── Cowork → server cron 마이그레이션 (2026-05-07) ────────────
      // Cowork 데이터 손실로 routines 모두 사라짐. 6개 자동화를 server-side로 이전 — Railway 인프라.
      // 모든 시간은 KST(Asia/Seoul) 기준. cron-utils가 UTC ↔ KST 변환 처리.
      if (env.LAB_ID && env.NOTION_API_KEY) {
        const { scheduleDailyKst, scheduleWeeklyKst } = await import('./services/cron-utils.js');
        const { runDeadlineReminders } = await import('./services/cron-deadline-reminders.js');
        const { runPaperMonitoring } = await import('./services/cron-paper-monitoring.js');
        const { runEmailBriefing } = await import('./services/cron-email-briefing.js');
        const { runIrisMonitoring } = await import('./services/cron-iris-monitoring.js');
        const { runGeneralEmailBriefing } = await import('./services/cron-general-email-briefing.js');
        const { runProcessSlackInbox } = await import('./services/cron-process-slack-inbox.js');

        // 1. 마감일 리마인더 — 매일 KST 09:00 (Notion 진행중 task 추적 + Slack DM)
        if (env.SLACK_BOT_TOKEN) {
          scheduleDailyKst(9, 0, async () => {
            const r = await runDeadlineReminders();
            console.log(
              `[deadline-reminder-cron] sent=${r.sentCount} skip(already)=${r.skippedAlreadySent} ` +
              `skip(notDue)=${r.skippedNotDue} failed=${r.failures.length}`,
            );
          }, 'deadline-reminder-cron');
        }

        // 2. 논문 모니터링 — 매주 월 KST 09:00 (RSS + AI 요약 + Notion + Slack #연구동향)
        scheduleWeeklyKst(1, 9, 0, async () => {
          const r = await runPaperMonitoring();
          console.log(
            `[paper-monitoring-cron] rss=${r.totalRssItems} filtered=${r.filteredCount} ` +
            `new=${r.newPapersCount} notion=${r.notionPageUpdated} slack=${r.slackPosted} errors=${r.errors.length}`,
          );
        }, 'paper-monitoring-cron');

        // 3. 학생/회사 주간보고 — 매주 월 KST 11:00 (Gmail → 요약 → Notion 멤버 페이지)
        scheduleWeeklyKst(1, 11, 0, async () => {
          const r = await runEmailBriefing('both');
          console.log(
            `[email-briefing-cron] emails=${r.emailsFound} updated=${r.membersUpdated} errors=${r.errors.length}`,
          );
        }, 'email-briefing-cron');

        // 4. IRIS R&D 공고 — 매주 월 KST 10:00 (크롤 + 신규만 Notion DB 추가)
        scheduleWeeklyKst(1, 10, 0, async () => {
          const r = await runIrisMonitoring();
          console.log(
            `[iris-monitoring-cron] crawled=${r.totalCrawled} new=${r.newProjectsAdded} ` +
            `skip=${r.skippedExisting} errors=${r.errors.length}`,
          );
        }, 'iris-monitoring-cron');

        // 5. 일반 이메일 브리핑 — 매일 KST 07:00 (Gmail 24h → 분류 → PI Slack DM)
        if (env.SLACK_BOT_TOKEN && env.ADMIN_USER_ID) {
          scheduleDailyKst(7, 0, async () => {
            const r = await runGeneralEmailBriefing();
            console.log(
              `[general-email-briefing-cron] scanned=${r.emailsScanned} briefed=${r.emailsBriefed} ` +
              `excluded=${r.excludedWeeklyReports} dm=${r.slackDmSent} errors=${r.errors.length}`,
            );
          }, 'general-email-briefing-cron');
        }

        // 6. Slack inbox 처리 — 매일 KST 08:30 (채널 polling → LLM 분류 → 검토 큐)
        if (env.SLACK_BOT_TOKEN) {
          scheduleDailyKst(8, 30, async () => {
            const r = await runProcessSlackInbox();
            console.log(
              `[process-slack-inbox-cron] channels=${r.channelsScanned} msgs=${r.messagesScanned} ` +
              `filtered=${r.messagesAfterFilter} new=${r.newCaptures} dup=${r.skippedDup} errors=${r.errors.length}`,
            );
          }, 'process-slack-inbox-cron');
        }
      } else {
        console.log('[automation-cron] LAB_ID / NOTION_API_KEY 미설정 — 자동화 모두 스킵');
      }

      console.log(`
      ╔═══════════════════════════════════════════════╗
      ║           LabFlow API Server                  ║
      ╠═══════════════════════════════════════════════╣
      ║  URL:    http://${env.HOST}:${env.PORT}              ║
      ║  Env:    ${env.NODE_ENV.padEnd(36)}║
      ║  Gemini: [ok] Connected                       ║
      ║  Auth:   ${env.SUPABASE_JWT_SECRET ? '[ok] Supabase' : '[dev] Dev mode'}${''.padEnd(env.SUPABASE_JWT_SECRET ? 20 : 20)}║
      ╚═══════════════════════════════════════════════╝
          `);
    } catch (err) {
          console.error('[error] 서버 시작 실패:', err);
          process.exit(1);
    }
}

start();
