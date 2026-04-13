# Claude Code Prompt: Brain Chat Gemini system_instruction 에러 수정

아래 프롬프트를 Claude Code에 붙여넣으세요 (`--dangerously-skip-permissions` 모드 권장):

---

```
server/src/routes/brain.ts 파일에서 Brain Chat의 Gemini API system_instruction 에러를 수정해줘.

## 문제
POST /api/brain/chat 엔드포인트 (약 883~916줄 부근)에서:
- model.startChat({ systemInstruction: systemPrompt }) 에 plain string을 넘기고 있음
- Gemini 2.0 Flash API는 systemInstruction을 Content 객체 형식으로 요구함
- 에러: [GoogleGenerativeAI Error]: Invalid value at 'system_instruction' (type.googleapis.com/google.ai.generativelanguage.v1beta.Content)
- build3LayerContext()가 Lab Profile 전체(구성원 20명, 과제 10개, FAQ, 용어사전 등)를 넣어서 system prompt이 과도하게 길어질 수 있음

## 수정 사항

### 1. systemInstruction 포맷 수정
startChat()에 systemInstruction을 넘길 때 Content 객체 형식으로 변환:

```typescript
const chat = model.startChat({
  history: chatHistory,
  systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
});
```

또는 getGenerativeModel에서 설정:
```typescript
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
});
```

둘 중 하나 택 — startChat 방식이 더 깔끔함.

### 2. system prompt 길이 제한
build3LayerContext() 결과를 system prompt에 직접 넣지 말고, 토큰 절약을 위해:
- systemPrompt는 핵심 규칙만 유지 (현재 888~899줄의 규칙 부분)
- layerContext는 userContent에 [참고 컨텍스트]로 주입 (dbResult처럼)
- 즉, layerContext를 system prompt에서 빼고 사용자 메시지 앞에 prepend

수정 후 구조:
```typescript
// systemPrompt: 핵심 규칙만 (짧게)
const systemPrompt = `당신은 연구실 AI 비서 "ResearchFlow 미니브레인"입니다.
${lab?.responseStyle === 'casual' ? '친근하고 캐주얼한 어조로 답변하세요.' : '정중하고 전문적인 어조로 답변하세요.'}

핵심 규칙:
1. DB에 등록된 정보만 답변합니다. 추측하거나 지어내지 마세요.
2. [DB 조회 결과]가 제공되면, 그 결과를 자연스럽게 정리하여 전달하세요.
3. 정보가 없으면 "등록된 정보가 없습니다. 추가하시겠어요?"로 유도하세요.
4. 복합 질의의 경우, 연결 관계를 명확히 설명하세요.
5. 대화 중 새로운 연구실 정보가 언급되면 기억합니다.
6. ⚠️ 경고가 있으면 신뢰도 상태를 사용자에게 전달하세요.`;

// layerContext + dbResult → 사용자 메시지에 합침
let userContent = message;
if (layerContext) {
  userContent = `[연구실 컨텍스트]\n${layerContext}\n\n${userContent}`;
}
if (dbResult) {
  userContent = `${userContent}\n\n[DB 조회 결과 — 이 데이터만으로 답변하세요]\n${dbResult}`;
}

const chat = model.startChat({
  history: chatHistory,
  systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
});
```

### 3. classifyIntent 함수도 같은 패턴 확인 (142줄)
classifyIntent()는 model.generateContent(prompt)를 쓰므로 systemInstruction 문제는 없음. 건드리지 마.

### 4. "LabFlow" → "ResearchFlow" 이름 통일
systemPrompt 안의 "LabFlow 미니브레인"을 "ResearchFlow 미니브레인"으로 변경.

## 검증
수정 후:
1. npx tsc --noEmit 으로 타입 에러 확인
2. npm run build 성공 확인
3. 가능하면 curl로 brain/chat 테스트:
   curl -X POST https://labflow-app-production.up.railway.app/api/brain/chat \
     -H "Content-Type: application/json" \
     -H "X-Dev-User-Id: dev-user-seo" \
     -d '{"message": "안녕"}'

## 주의
- basePrismaClient import와 auth.ts는 이미 수정 완료 — 건드리지 마
- prisma-filter.ts도 건드리지 마
- 다른 route 파일도 건드리지 마
- brain.ts 내 다른 함수들(classifyIntent, executeMultiHopQuery, build3LayerContext 등)은 작동 중이므로 systemInstruction 관련 부분만 수정
```

---

## 요약
| 항목 | 변경 내용 |
|------|-----------|
| **파일** | `server/src/routes/brain.ts` |
| **위치** | ~913-916줄 (startChat 호출부) |
| **핵심 수정** | systemInstruction을 Content 객체로 변환 |
| **부가 수정** | layerContext를 system prompt에서 user message로 이동 |
| **이름 통일** | LabFlow → ResearchFlow |
