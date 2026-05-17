import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(), // Claude Sonnet (이메일 분류 + 회의 요약)
  OPENAI_API_KEY: z.string().optional(), // OpenAI Realtime API (Voice Chatbot)
  TOKEN_ENCRYPTION_KEY: z.string().optional(), // AES-256 for OAuth token encryption
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(), // GDrive 동기화용 고정 토큰 (PI 계정)
  GOOGLE_REDIRECT_URI: z.string().default('https://labflow-app-production.up.railway.app/api/email/auth/callback'),
  NOTION_API_KEY: z.string().optional(),
  // 📝 연구실 할 일·요청 (Slack 자동 추출) DB ID override.
  // 미설정 시 cron-deadline-reminders.ts의 default 사용 (현재 bcaf30f0-...).
  // Notion에서 DB 위치 이동되면 새 ID로 env 설정 → 즉시 반영 (코드 수정 없이).
  NOTION_TASK_DB_ID: z.string().optional(),
  GDRIVE_FILE_ACCOUNTS: z.string().optional(),       // BLISS 아이디/비밀번호 스프레드시트 ID
  GDRIVE_FILE_PROJECT_INFO: z.string().optional(),   // 과제 정보 스프레드시트 ID
  GDRIVE_FILE_ACKNOWLEDGMENT: z.string().optional(), // 과제 사사 스프레드시트 ID
  GDRIVE_FILE_MEMBER_INFO: z.string().optional(),    // 인적사항 파일 ID (xlsx 또는 Sheets)
  LAB_ID: z.string().optional(),                     // 자동 동기화용 Lab ID
  SLACK_BOT_TOKEN: z.string().optional(),             // Slack DM 발송용 Bot token
  FRONTEND_URL: z.string().default('https://labflow-web.vercel.app'), // Vercel 프로젝트: labflow-web
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:3000,https://labflow-web.vercel.app'),
  // 외부 워커 → server-to-server sync (bliss-slack-worker → /api/sync/bliss-task)
  LABFLOW_SYNC_TOKEN: z.string().optional(),
  LAB_OWNER_CLERK_ID: z.string().optional(),  // Capture 소유자 결정 (default: dev-user-seo)
  LAB_OWNER_EMAIL: z.string().optional(),
  // labflow-member API base URL (BLISS-bot 미답변 질문 follow-up 프록시 등)
  LABFLOW_MEMBER_URL: z.string().default('https://labflow-member-production.up.railway.app'),
  // bliss-slack-bot ↔ labflow-app server-to-server (worksheet App Home reminders 조회 등)
  SLACK_RELAY_SECRET: z.string().optional(),
  // BLISS Lab Google Calendar ID — 학생 휴가 자동 등록 대상.
  // 미설정 시 PI primary calendar에 등록.
  // 별도 캘린더 사용 시 Google Calendar 설정에서 "캘린더 ID" 복사 (예: xxxxx@group.calendar.google.com)
  BLISS_LAB_CALENDAR_ID: z.string().optional(),
  // PI Slack user ID — general-email-briefing 결과를 PI에게 DM 발송 + 기타 ADMIN 알림용.
  // 메모리 bliss_slack_workspace.md: U0ASESNE1UP (서정목, 워크스페이스 owner).
  ADMIN_USER_ID: z.string().optional(),
});

function loadEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[error] 환경변수 오류:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env: z.infer<typeof envSchema> = loadEnv();
export type Env = z.infer<typeof envSchema>;
