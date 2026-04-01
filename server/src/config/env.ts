import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),
  CLERK_SECRET_KEY: z.string().optional(), // Legacy — 제거 예정
  CLERK_PUBLISHABLE_KEY: z.string().optional(), // Legacy — 제거 예정
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(), // Claude Sonnet (이메일 분류 + 회의 요약)
  OPENAI_API_KEY: z.string().optional(), // OpenAI Realtime API (Voice Chatbot)
  TOKEN_ENCRYPTION_KEY: z.string().optional(), // AES-256 for OAuth token encryption (fallback: CLERK_SECRET_KEY)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('https://labflow-app-production.up.railway.app/api/email/auth/callback'),
  FRONTEND_URL: z.string().default('https://labflow-web.vercel.app'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:3000,https://labflow-web.vercel.app'),
});

function loadEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ 환경변수 오류:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env: z.infer<typeof envSchema> = loadEnv();
export type Env = z.infer<typeof envSchema>;
