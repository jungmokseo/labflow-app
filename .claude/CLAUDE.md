# LabFlow App — Claude Code 지침

## 프로젝트 구조
- `server/` — Fastify API 서버 (Railway 배포)
- `web/` — Next.js 프론트엔드 (Vercel 배포)

## 빌드 & 배포 규칙
- 커밋 전 반드시 `cd server && npx tsc --noEmit` + `cd web && npx tsc --noEmit` 에러 0건 확인
- Railway 서버는 cold start 시 502/503 반환 → Vercel rewrites로 프록시 (CORS 우회)
- Prisma 스키마 변경 시 반드시 `npx prisma db push` 실행

## 절대 수정 금지 영역 (Critical — DO NOT MODIFY)

### 1. OAuth 인증 흐름 (email.ts)
- `ensureUser()` 함수: `id` → `clerkId` 순서로 검색. 절대 `clerkId`만으로 검색하지 마라.
- `emailCallbackRoute`: 기존 토큰 deleteMany → 새로 create 순서. update 방식으로 되돌리지 마라.
- `auth/url` 엔드포인트: revokeCredentials → deleteMany → generateAuthUrl 순서 유지.
- `GOOGLE_REDIRECT_URI`: callback URL 변경 금지.

### 2. API 프록시 (CORS 우회)
- `web/next.config.js`의 rewrites 설정: /api/* → Railway 프록시. 제거하면 CORS 에러 재발.
- `web/src/lib/api.ts`의 API_BASE: 브라우저에서는 '' (빈 문자열 = 같은 origin). Railway URL 직접 사용 금지.

### 3. Service Worker
- `web/public/sw.js`: 페이지 캐싱 금지. 현재 network-only 정책 유지.
- 캐시 버전(CACHE_NAME) 변경 시 반드시 이전 버전보다 높은 번호 사용.

### 4. Email Briefing 직접 반환
- `brain.ts`의 `directPassthroughIntents` + `narrativeBriefingSuccess`: email_briefing 성공 시 Gemini를 거치지 않고 Sonnet 결과 직접 반환.
- 이 흐름을 Gemini 경유로 되돌리면 줄글 변환 문제 재발.

### 5. saveShadowMessage userId
- `saveShadowMessage()`: channel에서 userId를 조회하여 createMany에 포함. userId 누락 금지.

## AI 모델 사용 규칙
- 이메일 브리핑 (narrative-briefing): Sonnet → Gemini fallback
- 주간 리뷰 (weeklyReview): Sonnet → Gemini fallback  
- Brain 채팅 최종 응답: Gemini 2.5 Flash
- 논문 토론: Opus → Gemini fallback
- 회의 요약: Sonnet (summarizeWithSonnet)
- 음성 전사: Gemini 2.5 Flash (STT)

## 이메일 브리핑 포맷 규칙
- 각 이메일은 빈 줄로 구분된 별도 항목
- [긴급]/[대응] 항목이 맨 위
- 요약 섹션: 각 항목 별도 줄 + 불릿(-)
- 이모지 사용 금지
