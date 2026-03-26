# LabFlow 배포 가이드 (Session #12)

## 1. Vercel 웹 대시보드 배포

### 사전 조건
- GitHub: jungmokseo/labflow-app (main, commit 500813f)
- web/ 디렉토리에 Next.js 14 앱 준비 완료

### 단계
1. https://vercel.com/new 접속
2. "Import Git Repository" → `jungmokseo/labflow-app` 선택
3. **Project Settings:**
   - **Project Name:** `labflow-web`
   - **Framework Preset:** Next.js
   - **Root Directory:** `web` (중요!)
   - **Build Command:** (기본값 유지: `next build`)
   - **Output Directory:** (기본값 유지: `.next`)
4. **Environment Variables:**
   - `NEXT_PUBLIC_API_URL` = `https://labflow-api.onrender.com`
5. "Deploy" 클릭

### 배포 후 확인
- 배포 URL에서 대시보드 로딩 확인
- /captures, /email, /meetings, /settings 페이지 접근 확인
- API 연동 (캡처 CRUD, 이메일 상태) 확인

---

## 2. Clerk 인증 설정

### 단계
1. https://clerk.com 접속 → 로그인/가입
2. "Create Application" → 앱 이름: `LabFlow`
3. Sign-in 옵션: Email + Google OAuth 선택
4. 대시보드에서 키 복사:
   - **Publishable Key:** `pk_test_...` 또는 `pk_live_...`
   - **Secret Key:** `sk_test_...` 또는 `sk_live_...`

### 키 설정
```bash
# server/.env에 추가
CLERK_SECRET_KEY=sk_test_xxxxx

# labflow-app 루트 .env에 추가 (Expo용)
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxxxx

# web/.env.local에 추가 (Next.js용)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxxxx
```

### 동작 확인
- AuthProvider.tsx가 EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY 감지 시 자동 Clerk 모드 전환
- server auth 미들웨어가 CLERK_SECRET_KEY 감지 시 JWT 검증 활성화
- `npm install @clerk/clerk-expo` (Expo 모바일)
- `npm install @clerk/nextjs` (웹 대시보드)

---

## 3. 현재 배포 상태

| 컴포넌트 | 상태 | URL |
|---------|------|-----|
| API 서버 | ✅ Live | https://labflow-api.onrender.com |
| 모바일 앱 | ✅ 코드 완료 | Expo Go / 빌드 필요 |
| 웹 대시보드 | ⏳ Vercel 배포 대기 | (배포 후 URL 기록) |
| 인증 | ⏳ Clerk 설정 대기 | Dev Mode로 동작 중 |
