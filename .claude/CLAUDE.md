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

## AI 모델 사용 규칙 (2026-05-07 update)

### 모델 ID (최신)
- **Sonnet 4.6** (`claude-sonnet-4-6`) — 기본 LLM, 1M context, temperature OK
- **Opus 4.7** (`claude-opus-4-7`) — 1M context 기본, ⚠️ `temperature`/`top_p`/`top_k` 미지원 (400 에러)
- **Gemini 3.1 Flash-Lite** (`gemini-3.1-flash-lite`) — light task + fallback, stable
- **OpenAI Realtime 2** (`gpt-realtime-2`) — voice chatbot 전용 (2026-05-07 이전 `gpt-4o-realtime-preview-2025-06-03` deprecated 후 교체)
- **OpenAI Embedding** (`text-embedding-3-small`) — labflow-member RAG embedding 전용

### 영역별 모델 (코드 ↔ 규칙 일치)
- 이메일 분류 stage 1 (대량/빠른 필터): Gemini 3.1 Flash-Lite
- 이메일 분류 stage 2 (LLM 정밀): Sonnet 4.6
- 이메일 narrative briefing: Sonnet 4.6 → Gemini fallback (Sonnet 결과 직접 passthrough — 위 4번 규칙 참조)
- 주간 리뷰 (weeklyReview, weekly-briefing.ts): Sonnet 4.6
- **Brain 채팅: Sonnet 4.6** (tool-use 루프 + 최종 응답 스트리밍 모두) → Gemini 3.1 Flash-Lite fallback (Sonnet API 실패 시만)
- 논문 토론 / 핵심 논문 비교 (papers tool, paper-alerts paper_summary): **Opus 4.7** → Sonnet 4.6 fallback → Gemini 3.1 Flash-Lite fallback
- 논문 관련도 score / weekly insight: Sonnet 4.6 → Gemini fallback
- 회의 요약 (meeting_summary): Sonnet 4.6 → Gemini 3.1 Flash-Lite fallback
- 음성 전사 (meeting STT): Gemini 3.1 Flash-Lite (audio input)
- Capture classifier / 메모 자동 태그 / Calendar 추출 / Email translate / action items 추출: Gemini 3.1 Flash-Lite
- 자동화 cron AI (paper-monitoring 한글 요약, email-briefing 학생 보고 요약, general-email-briefing 분류, process-slack-inbox 분류): Sonnet 4.6 → Gemini 3.1 Flash-Lite fallback

### 모델 변경 시 주의
- Opus 4.7 호출 site에서 `temperature` 등 sampling 파라미터 추가 금지 (400 에러)
- Gemini Flash-Lite는 lite variant — quality 민감 task에서 quality 저하 느끼면 `gemini-3-flash-preview` (frontier preview)로 switch 검토
- 모델 ID 변경 시 `services/cron-*.ts` + `routes/*.ts` 일괄 sed 권장 (이전 사례: `claude-sonnet-4-20250514` 1년 deprecation 도래로 일괄 교체)

## 이메일 브리핑 포맷 규칙
- 각 이메일은 빈 줄로 구분된 별도 항목
- [긴급]/[대응] 항목이 맨 위
- 요약 섹션: 각 항목 별도 줄 + 불릿(-)
- 이모지 사용 금지
