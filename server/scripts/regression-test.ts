/**
 * LabFlow MVP 회귀 테스트 스크립트
 *
 * 모든 핵심 API 엔드포인트를 순차 호출하여 정상 응답 확인.
 * Railway 배포 후 또는 코드 변경 후 실행.
 *
 * Usage:
 *   npx tsx scripts/regression-test.ts [BASE_URL]
 *   기본값: https://labflow-app-production.up.railway.app
 */

const BASE_URL = process.argv[2] || 'https://labflow-app-production.up.railway.app';

interface TestResult {
  name: string;
  method: string;
  path: string;
  status: number;
  pass: boolean;
  detail?: string;
}

const results: TestResult[] = [];
let authToken = '';

// ── Helper ────────────────────────────────────────────

async function test(
  name: string,
  method: string,
  path: string,
  options?: {
    body?: any;
    auth?: boolean;
    expectedStatus?: number | number[];
    validate?: (body: any) => boolean;
  },
) {
  const { body, auth = true, expectedStatus = [200, 201], validate } = options || {};
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && authToken) headers['Authorization'] = `Bearer ${authToken}`;

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await res.json().catch(() => null);
    const pass = expected.includes(res.status) && (!validate || validate(responseBody));

    results.push({
      name,
      method,
      path,
      status: res.status,
      pass,
      detail: pass ? undefined : JSON.stringify(responseBody)?.slice(0, 200),
    });
    return responseBody;
  } catch (err: any) {
    results.push({
      name,
      method,
      path,
      status: 0,
      pass: false,
      detail: err.message?.slice(0, 200),
    });
    return null;
  }
}

// ── Tests ─────────────────────────────────────────────

async function runTests() {
  console.log(`\n🧪 LabFlow MVP Regression Test`);
  console.log(`   Target: ${BASE_URL}\n`);

  // ── 1. Health (Public) ──────────────────────────────
  await test('Health check /', 'GET', '/', { auth: false });
  await test('Health check /health', 'GET', '/health', { auth: false });

  // ── 2. Auth 없이 보호된 엔드포인트 접근 시 401 ─────
  await test('Captures requires auth', 'GET', '/api/captures', {
    auth: false,
    expectedStatus: [401],
  });

  // ── 3. Lab Profile (Auth) ──────────────────────────
  const labRes = await test('Get lab profile', 'GET', '/api/lab');
  const labId = labRes?.data?.id;

  await test('Get lab completeness', 'GET', '/api/lab/completeness');
  await test('Get lab members', 'GET', '/api/lab/members');
  await test('Get lab projects', 'GET', '/api/lab/projects');
  await test('Get lab publications', 'GET', '/api/lab/publications');
  await test('Get domain dictionary', 'GET', '/api/lab/dictionary');

  // ── 4. Captures CRUD ───────────────────────────────
  const captureRes = await test('Create capture', 'POST', '/api/captures', {
    body: { text: '회귀 테스트용 캡처 — 자동 삭제됩니다' },
    expectedStatus: [200, 201],
  });
  const captureId = captureRes?.data?.id;

  await test('List captures', 'GET', '/api/captures');

  if (captureId) {
    await test('Get capture', 'GET', `/api/captures/${captureId}`);
    await test('Update capture (reviewed)', 'PATCH', `/api/captures/${captureId}`, {
      body: { reviewed: true },
    });
    await test('Delete capture', 'DELETE', `/api/captures/${captureId}`);
  }

  // ── 5. Brain Chat ──────────────────────────────────
  await test('Brain channels list', 'GET', '/api/brain/channels');

  const chatRes = await test('Brain chat', 'POST', '/api/brain/chat', {
    body: { message: '안녕하세요, 회귀 테스트입니다', newSession: true },
    validate: (b) => !!b?.response && !!b?.channelId,
  });
  const testChannelId = chatRes?.channelId;

  if (testChannelId) {
    await test('Get brain channel messages', 'GET', `/api/brain/channels/${testChannelId}`);
    await test('Delete brain channel', 'DELETE', `/api/brain/channels/${testChannelId}`);
  }

  // ── 6. Brain Search ────────────────────────────────
  await test('Brain memory search', 'GET', '/api/brain/search?query=test&type=all');

  // ── 7. Meetings ────────────────────────────────────
  await test('List meetings', 'GET', '/api/meetings');

  // ── 8. Email ───────────────────────────────────────
  await test('Email status', 'GET', '/api/email/status');
  await test('Email profile', 'GET', '/api/email/profile', { expectedStatus: [200, 404] });

  // ── 9. Paper Alerts ────────────────────────────────
  await test('Paper alert fields', 'GET', '/api/papers/journals/fields');
  await test('Paper alerts list', 'GET', '/api/papers/alerts');
  await test('Paper alert results', 'GET', '/api/papers/alerts/results');

  // ── 10. Papers ─────────────────────────────────────
  await test('Papers list', 'GET', '/api/papers', { auth: false });

  // ── 11. Briefing ───────────────────────────────────
  await test('Get briefing', 'GET', '/api/briefing', { expectedStatus: [200, 500] });

  // ── 12. Calendar ───────────────────────────────────
  await test('Calendar today', 'GET', '/api/calendar/today', { expectedStatus: [200, 500] });
  await test('Calendar pending', 'GET', '/api/calendar/pending', { expectedStatus: [200, 500] });

  // ── 13. Knowledge Graph ────────────────────────────
  await test('Knowledge graph', 'GET', '/api/graph');

  // ── 14. Voice Chatbot (Public) ─────────────────────
  await test('Voice personas', 'GET', '/api/voice/personas', { auth: false });
  await test('Voice voices', 'GET', '/api/voice/voices', { auth: false });

  // ── 15. Tasks page data ────────────────────────────
  await test('Captures (tasks filter)', 'GET', '/api/captures?category=TASK&sort=newest');
  await test('Captures (ideas filter)', 'GET', '/api/captures?category=IDEA&sort=newest');

  // ── Results ────────────────────────────────────────
  printResults();
}

function printResults() {
  console.log('\n' + '═'.repeat(70));
  console.log('  REGRESSION TEST RESULTS');
  console.log('═'.repeat(70));

  const passed = results.filter(r => r.pass);
  const failed = results.filter(r => !r.pass);

  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    const status = r.status || 'ERR';
    console.log(`  ${icon} [${r.method.padEnd(6)} ${status}] ${r.name}`);
    if (!r.pass && r.detail) {
      console.log(`     └─ ${r.detail}`);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`  Total: ${results.length} | Pass: ${passed.length} | Fail: ${failed.length}`);
  console.log('─'.repeat(70));

  if (failed.length > 0) {
    console.log('\n⚠️ 실패한 테스트가 있습니다. 위 항목을 확인하세요.');
    process.exit(1);
  } else {
    console.log('\n🎉 모든 회귀 테스트 통과!');
  }
}

// ── Entry Point ──────────────────────────────────────

(async () => {
  // Clerk 토큰이 환경변수로 제공되면 사용
  authToken = process.env.LABFLOW_TEST_TOKEN || '';

  if (!authToken) {
    console.log('⚠️ LABFLOW_TEST_TOKEN 미설정 — 인증 필요 엔드포인트는 401 예상');
    console.log('   설정: LABFLOW_TEST_TOKEN=<clerk-jwt> npx tsx scripts/regression-test.ts\n');
  }

  await runTests();
})();
