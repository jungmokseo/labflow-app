/**
 * Google Drive 동기화 서비스 (labflow-app Brain용)
 *
 * 대상 파일 (전체 탭 읽기):
 * 1. 과제 정보 (Sheets) → Project 테이블
 * 2. 과제 사사 (Sheets) → Acknowledgment 테이블
 * 3. 인적사항 (xlsx/Sheets) → MemberInfo 테이블
 * 4. BLISS 아이디/비밀번호 (Sheets) → LabAccount 테이블
 *
 * 인증: GOOGLE_REFRESH_TOKEN (PI 계정 고정 토큰)
 */

import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { decryptToken, isEncrypted } from '../utils/crypto.js';

// ── Google Auth ─────────────────────────────────────────────────
//
// 인증 우선순위:
//   1) env.GOOGLE_REFRESH_TOKEN  — Railway에 박힌 고정 토큰 (PI 계정)
//   2) DB GmailToken (primary)    — 사용자가 /settings에서 재발급한 토큰 (자동 fallback)
// 둘 다 실패 시 invalid_grant 등 명확한 에러 메시지로 throw.
//
// 토큰 캐시는 _auth에 저장. 인증 실패 또는 401 응답 시 resetAuthCache()로 재시도 가능.

let _auth: any = null;
let _authSource: 'env' | 'gmail-token' | null = null;

interface AuthDiagnosis {
  source: 'env' | 'gmail-token' | 'none';
  ownerEmail?: string;
  scopes?: string[];           // 실제 부여된 scope (drive/sheets 권한 확인용)
  scopeIssue?: string;         // scope 부족 시 안내 메시지
  errors: string[];
}

let _lastDiagnosis: AuthDiagnosis | null = null;

export function getLastAuthDiagnosis(): AuthDiagnosis | null {
  return _lastDiagnosis;
}

function summarizeScopes(scopes: string[]): string | undefined {
  // 빈 배열은 진단 실패(getTokenInfo 응답 못 받음)로 간주. False positive 방지 — 일단 토큰을 신뢰하고
  // 실제 sync 호출 시 권한 문제가 있으면 readAllSheets의 catch에서 명확한 메시지로 잡힌다.
  if (scopes.length === 0) return undefined;

  // env.GDRIVE_FILE_* 시트 sync는 PI가 직접 만든 파일을 읽는다.
  // → drive.file scope(앱이 만든/연 파일만)으로는 부족. drive.readonly 또는 full drive 권한 필요.
  const hasDriveReadOrFull = scopes.some(s => /\/auth\/drive(\.readonly)?$/.test(s));
  const hasDriveFile = scopes.some(s => s.includes('/auth/drive.file'));
  if (!hasDriveReadOrFull) {
    if (hasDriveFile) {
      return 'drive.file만 부여됨 — 사용자가 직접 만든 시트는 못 읽음. /settings에서 Gmail 재연결 시 동의 화면에서 "Drive 보기"(drive.readonly) 체크 필수';
    }
    return 'Drive scope 없음 — /settings에서 Gmail 재연결 + 동의 화면에서 "Drive 보기"(drive.readonly) 체크';
  }
  return undefined;
}

async function tryAuthWithRefreshToken(refreshToken: string, label: string): Promise<{ client: any; scopes: string[] }> {
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  oauth2.setCredentials(credentials);

  // 실제 부여된 scope 확인 (재연결 시 사용자가 동의 화면에서 일부 scope을 거절했을 수 있음)
  let scopes: string[] = [];
  try {
    if (credentials.access_token) {
      const info = await oauth2.getTokenInfo(credentials.access_token);
      scopes = info.scopes || [];
    }
  } catch (e: any) {
    console.warn(`[gdrive] tokenInfo 조회 실패 (${label}): ${e?.message || e}`);
  }

  console.log(`[gdrive] OAuth 인증 성공 (${label}), scopes=[${scopes.map(s => s.split('/').pop()).join(', ')}]`);
  return { client: oauth2, scopes };
}

async function findOwnerGmailToken() {
  // PI(OWNER) 식별 — 학생 등 임의 사용자 토큰 사용 방지 (cross-user contamination guard).
  // 우선순위:
  //   1) LAB_OWNER_EMAIL          (env)
  //   2) LAB_OWNER_CLERK_ID       (env)
  //   3) LAB_ID + Lab.ownerId     (Lab 모델의 명시적 PI 필드 — 가장 신뢰)
  //   4) LAB_ID + LabMember(OWNER) (옵션 — Lab.ownerId 없을 때)
  if (env.LAB_OWNER_EMAIL) {
    const t = await prisma.gmailToken.findFirst({
      where: {
        OR: [
          { email: env.LAB_OWNER_EMAIL },
          { user: { is: { email: env.LAB_OWNER_EMAIL } } },
        ],
        refreshToken: { not: null },
      },
      orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
    });
    if (t) return t;
  }
  if (env.LAB_OWNER_CLERK_ID) {
    const t = await prisma.gmailToken.findFirst({
      where: { user: { is: { clerkId: env.LAB_OWNER_CLERK_ID } }, refreshToken: { not: null } },
      orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
    });
    if (t) return t;
  }
  if (env.LAB_ID) {
    // Lab.ownerId — 가장 권위 있는 PI 식별 경로 (Lab 모델이 직접 owner를 가리킴)
    const lab = await prisma.lab.findUnique({
      where: { id: env.LAB_ID },
      select: { ownerId: true },
    });
    if (lab?.ownerId) {
      const t = await prisma.gmailToken.findFirst({
        where: { userId: lab.ownerId, refreshToken: { not: null } },
        orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
      });
      if (t) return t;
    }
    // 마지막 안전망: LabMember.permission='OWNER' (Lab.ownerId 없을 때만)
    const ownerMember = await prisma.labMember.findFirst({
      where: { labId: env.LAB_ID, permission: 'OWNER', userId: { not: null }, active: true },
      select: { userId: true },
    });
    if (ownerMember?.userId) {
      const t = await prisma.gmailToken.findFirst({
        where: { userId: ownerMember.userId, refreshToken: { not: null } },
        orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
      });
      if (t) return t;
    }
  }
  // Fail closed — OWNER를 식별할 수 없으면 fallback 거부
  return null;
}

async function getAuth() {
  if (_auth) return _auth;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth 클라이언트 정보 미설정 (GOOGLE_CLIENT_ID/SECRET).');
  }
  google.options({ timeout: 30000 });

  const diag: AuthDiagnosis = { source: 'none', errors: [] };

  // 1순위: env.GOOGLE_REFRESH_TOKEN — 단, scope이 부족하면 GmailToken으로 fallback.
  // (env 토큰이 옛 scope으로 발급되어 drive.readonly가 없는 경우 — 사용자가 /settings에서
  //  새 scope으로 재연결한 GmailToken을 쓰는 게 정답. 이전엔 underscored env 토큰을 그대로
  //  쓰고 fallback을 안 해서 사용자가 재연결해도 영원히 File not found 받음.)
  if (env.GOOGLE_REFRESH_TOKEN) {
    try {
      const r = await tryAuthWithRefreshToken(env.GOOGLE_REFRESH_TOKEN, 'env.GOOGLE_REFRESH_TOKEN');
      const issue = summarizeScopes(r.scopes);
      if (!issue) {
        _auth = r.client;
        _authSource = 'env';
        diag.source = 'env';
        diag.scopes = r.scopes;
        _lastDiagnosis = diag;
        return _auth;
      }
      console.warn(`[gdrive] env.GOOGLE_REFRESH_TOKEN scope 부족: ${issue} → GmailToken fallback 시도`);
      diag.errors.push(`env_token: under-scoped — ${issue}`);
    } catch (e: any) {
      const msg = e?.response?.data?.error_description || e?.response?.data?.error || e?.message || 'unknown';
      console.error(`[gdrive] env.GOOGLE_REFRESH_TOKEN 실패: ${msg} → GmailToken fallback 시도`);
      diag.errors.push(`env_token: ${msg}`);
    }
  } else {
    diag.errors.push('env_token: not_set');
  }

  // 2순위: OWNER GmailToken (DB) — LAB_OWNER_* env 또는 Lab.ownerId / LabMember(OWNER)로 식별
  // findOwnerGmailToken이 cross-user contamination을 방지하므로 안전.
  try {
    const token = await findOwnerGmailToken();
    if (token?.refreshToken) {
      const refresh = isEncrypted(token.refreshToken) ? decryptToken(token.refreshToken) : token.refreshToken;
      const r = await tryAuthWithRefreshToken(refresh, `GmailToken:${token.email}`);
      const issue = summarizeScopes(r.scopes);
      diag.ownerEmail = token.email;
      diag.scopes = r.scopes;
      // scope 부족이면 client를 캐시하지 않고 명확한 에러로 throw
      // (env 토큰이 옛 scope, GmailToken도 옛 scope일 때 — 사용자가 새 scope으로 재연결 필요).
      if (issue) {
        diag.scopeIssue = issue;
        throw new Error(
          `GmailToken (${token.email}) scope 부족: ${issue}. ` +
          `/settings에서 Gmail 연결을 끊고 다시 연결할 때 "Drive 보기" 체크 필수.`,
        );
      }
      _auth = r.client;
      _authSource = 'gmail-token';
      diag.source = 'gmail-token';
      _lastDiagnosis = diag;
      return _auth;
    }
    diag.errors.push(
      env.LAB_OWNER_EMAIL || env.LAB_OWNER_CLERK_ID || env.LAB_ID
        ? 'gmail_token: not_found (OWNER가 /settings에서 Gmail 미연결 또는 refresh token 없음)'
        : 'gmail_token: skipped (LAB_OWNER_EMAIL / LAB_OWNER_CLERK_ID / LAB_ID 모두 미설정)',
    );
  } catch (e: any) {
    const msg = e?.response?.data?.error_description || e?.response?.data?.error || e?.message || 'unknown';
    console.error(`[gdrive] GmailToken fallback 실패: ${msg}`);
    diag.errors.push(`gmail_token: ${msg}`);
  }

  _lastDiagnosis = diag;
  throw new Error(
    `GDrive OAuth 인증 실패. 해결: (1) /settings에서 Gmail 재연결 (drive.readonly + spreadsheets.readonly scope 포함됨) ` +
    `또는 (2) Railway env GOOGLE_REFRESH_TOKEN 갱신. [${diag.errors.join(' | ')}]`,
  );
}

// 토큰 캐시 리셋 (재인증 필요 시)
export function resetAuthCache() {
  _auth = null;
  _authSource = null;
}

export function getAuthSource(): 'env' | 'gmail-token' | null {
  return _authSource;
}

// ── 시트 데이터 타입 ─────────────────────────────────────────────

interface SheetData {
  sheetName: string;
  rows: string[][];
}

// ── Google Sheets 읽기 ──────────────────────────────────────────

async function readGoogleSheets(spreadsheetId: string): Promise<SheetData[]> {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = (meta.data.sheets || [])
    .map(s => s.properties?.title)
    .filter((t): t is string => !!t);

  console.log(`  시트 ${sheetNames.length}개: ${sheetNames.join(', ')}`);

  const settled = await Promise.allSettled(
    sheetNames.map(name =>
      Promise.race([
        sheets.spreadsheets.values.get({ spreadsheetId, range: `'${name}'!A:Z` }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout: ${name}`)), 15000),
        ),
      ]).then(res => ({ name, values: (res as any).data.values || [] })),
    ),
  );

  return settled
    .filter(r => r.status === 'fulfilled')
    .map(r => {
      const { name, values } = (r as PromiseFulfilledResult<any>).value;
      return {
        sheetName: name,
        rows: values.map((row: any[]) => row.map((cell: any) => String(cell ?? ''))),
      };
    });
}

// ── xlsx 파일 읽기 (Drive 다운로드 + XLSX 파싱) ─────────────────

async function readXlsxFile(fileId: string): Promise<SheetData[]> {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );

  const buffer = Buffer.from(res.data as ArrayBuffer);
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  return workbook.SheetNames.map((name: string) => {
    const ws = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    return { sheetName: name, rows: rows.map((r: string[]) => r.map((c: any) => String(c ?? ''))) };
  });
}

// ── 파일 타입 판별 후 읽기 ──────────────────────────────────────

export async function readAllSheets(fileId: string): Promise<SheetData[]> {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  let fileMeta;
  try {
    fileMeta = await drive.files.get({ fileId, fields: 'mimeType,name,owners(emailAddress)' });
  } catch (e: any) {
    const status = e?.response?.status || e?.code;
    const apiMsg = e?.response?.data?.error?.message || e?.message || 'unknown';
    // "File not found"은 Google이 권한 없는 파일에도 동일 에러를 반환 (정보 누출 방지).
    // 진단 정보 + 사용자가 시도할 수 있는 step을 에러 메시지에 포함.
    const diag = _lastDiagnosis;
    const tokenAccount = diag?.ownerEmail ? `현재 사용 중 토큰: ${diag.ownerEmail}` : '';
    const scopeIssue = diag?.scopeIssue ? `scope 문제: ${diag.scopeIssue}` : '';
    throw new Error(
      `${apiMsg} (file ${fileId}, status ${status}). ` +
      `원인 가능성: (1) 토큰 scope에 drive.readonly 없음 — /settings에서 Gmail 재연결 + Google 동의 화면에서 'Drive 보기' 체크 ` +
      `(2) 시트 owner != 토큰 계정 — 시트를 토큰 계정에 편집/뷰어로 공유. ` +
      `${tokenAccount} ${scopeIssue}`,
    );
  }

  const mimeType = fileMeta.data.mimeType || '';
  const owner = fileMeta.data.owners?.[0]?.emailAddress;
  console.log(`  파일: "${fileMeta.data.name}" (${mimeType.split('.').pop()}) owner=${owner || '?'}`);

  if (mimeType.includes('google-apps.spreadsheet')) {
    return readGoogleSheets(fileId);
  } else {
    // xlsx, csv 등 네이티브 파일
    return readXlsxFile(fileId);
  }
}

// ── 전체 GDrive 동기화 (4개 파일) ───────────────────────────────

export async function syncAllGdriveData(labId: string): Promise<{ file: string; rows: number; status: string; error?: string }[]> {
  const results: { file: string; rows: number; status: string; error?: string }[] = [];

  const tasks: { name: string; fileId: string | undefined; fn: () => Promise<number> }[] = [
    { name: '과제 정보', fileId: env.GDRIVE_FILE_PROJECT_INFO, fn: () => syncProjectInfo(labId) },
    { name: '과제 사사', fileId: env.GDRIVE_FILE_ACKNOWLEDGMENT, fn: () => syncAcknowledgments(labId) },
    { name: '인적사항', fileId: env.GDRIVE_FILE_MEMBER_INFO, fn: () => syncMemberInfo(labId) },
    { name: '계정 정보', fileId: env.GDRIVE_FILE_ACCOUNTS, fn: () => syncLabAccounts(labId) },
  ];

  // 인증 계열 에러 시 stale 캐시가 원인일 수 있어 1회 리셋+재시도.
  // (2026-07-13 발견: env 토큰이 6/24 만료된 뒤 module-level _auth 캐시가 영구 잔존 —
  //  cron 경로는 resetAuthCache를 호출하지 않아 19일간 전건 invalid_grant.
  //  DB GmailToken은 7/11 재연결로 fresh했지만 캐시 때문에 fallback이 작동할 기회가 없었음.)
  let authRetried = false;
  const isAuthError = (msg: string) => /invalid_grant|unauthorized|401|invalid_token|token.*expired/i.test(msg || '');

  for (const task of tasks) {
    if (!task.fileId) {
      console.log(`[gdrive] ${task.name} 스킵 (환경변수 미설정)`);
      continue;
    }
    console.log(`[gdrive] ${task.name} 동기화 중...`);
    try {
      const rows = await task.fn();
      results.push({ file: task.name, rows, status: 'success' });
      console.log(`[gdrive] ${task.name} 완료 (${rows}건)`);
    } catch (e: any) {
      if (isAuthError(e.message) && !authRetried) {
        authRetried = true;
        console.warn(`[gdrive] ${task.name} 인증 에러 → 캐시 리셋 후 재시도 (fresh 토큰으로 재인증)`);
        resetAuthCache();
        try {
          const rows = await task.fn();
          results.push({ file: task.name, rows, status: 'success' });
          console.log(`[gdrive] ${task.name} 재시도 성공 (${rows}건)`);
          continue;
        } catch (e2: any) {
          e = e2;
        }
      }
      console.error(`[gdrive] ${task.name} 실패:`, e.message);
      results.push({ file: task.name, rows: 0, status: 'error', error: e.message });
    }
  }

  // 동기화 로그 저장
  for (const r of results) {
    try {
      await prisma.gdriveSyncLog.create({
        data: {
          labId,
          fileId: '',
          fileName: r.file,
          dataType: r.file,
          rowsSync: r.rows,
          status: r.status,
          errorMsg: r.error,
        },
      });
    } catch (_e) {
      // 로그 저장 실패는 무시
    }
  }

  // 전건 실패 → ErrorLog 표면화 (이전엔 GdriveSyncLog에만 남아 settings 에러 탭·대시보드 어디에도 안 보였음)
  const attempted = results.length;
  if (attempted > 0 && results.every(r => r.status === 'error')) {
    try {
      await prisma.errorLog.create({
        data: {
          category: 'gdrive',
          severity: 'error',
          message: `GDrive 동기화 전건 실패 (${attempted}개 파일): ${results[0].error?.slice(0, 250) || 'unknown'}`,
          context: { files: results.map(r => r.file) },
        },
      });
    } catch (_e) { /* 로그 실패 무시 */ }
  }

  return results;
}

// ── 과제 정보 동기화 ──────────────────────────────────────────
//
// 구조:
//   "과제 정보" 탭 → 과제 목록 테이블 (사업명, 과제명, 기간, 담당자 등)
//   나머지 탭들   → 탭명 = 과제 단축명, 세로 key-value 형식 (사사문구 등)

async function syncProjectInfo(labId: string): Promise<number> {
  if (!env.GDRIVE_FILE_PROJECT_INFO) return 0;
  const allSheets = await readAllSheets(env.GDRIVE_FILE_PROJECT_INFO);
  let synced = 0;

  // 알려진 컬럼 키워드 — 매핑 후 나머지는 metadata.sheetExtras에 자동 보존
  const HANDLED_KEYWORDS = ['과제명', '사업명', '과제수행부처', '전문기관명', '과제기간', '기간', '담당자', '담당', '3책'];

  // 1단계: "과제 정보" 탭 → 과제 목록 upsert
  const mainSheet = allSheets.find(s => s.sheetName === '과제 정보');
  if (mainSheet && mainSheet.rows.length >= 2) {
    const headers = mainSheet.rows[0].map(h => h.trim());
    const col = (keyword: string) =>
      headers.findIndex(h => h.includes(keyword));

    // 알려지지 않은 컬럼 인덱스 (metadata.sheetExtras로 자동 추출)
    const handledIndexes = new Set<number>();
    headers.forEach((h, i) => {
      if (HANDLED_KEYWORDS.some(kw => h.includes(kw))) handledIndexes.add(i);
    });

    for (let i = 1; i < mainSheet.rows.length; i++) {
      const row = mainSheet.rows[i];
      const name = row[col('과제명')]?.trim();
      if (!name) continue;

      const knownData = {
        businessName:   row[col('사업명')]?.trim() || undefined,
        ministry:       row[col('과제수행부처')]?.trim() || undefined,
        funder:         row[col('전문기관명')]?.trim() || undefined,
        period:         row[col('과제기간')]?.trim() || row[col('기간')]?.trim() || undefined,
        pm:             row[col('담당자')]?.trim() || row[col('담당')]?.trim() || undefined,
        responsibility: row[col('3책')]?.trim() || undefined,
        gdriveRowIndex: i,
        syncedAt: new Date(),
      };

      // 알려지지 않은 컬럼 모두 extras에 (PI가 시트에 추가한 임의 컬럼 자동 보존)
      const extras: Record<string, string> = {};
      headers.forEach((h, idx) => {
        if (handledIndexes.has(idx)) return;
        const v = row[idx]?.trim();
        if (h && v) extras[h] = v;
      });

      // 기존 metadata 보존 + sheetExtras만 갱신 (PI 입력 namespace는 별개)
      const existing = await prisma.project.findFirst({ where: { labId, name }, select: { metadata: true } });
      const md = (existing?.metadata as Record<string, unknown> | null) || {};
      const newMd = { ...md, sheetExtras: extras };

      await prisma.project.upsert({
        where: { labId_name: { labId, name } },
        update: { ...knownData, metadata: newMd as any },
        create: { labId, name, ...knownData, metadata: newMd as any },
      });
      synced++;
    }
  }

  // 2단계: 나머지 탭들 → 사사문구 + 모든 key-value 자동 추출 (목표/마일스톤/담당 등 PI가 시트에 적은 모든 정보)
  const SKIP_TABS = new Set(['과제 정보', '참여율', '초격차산업', '미답변 질문']);
  const ACK_KEYS = ['사사문구(국문)', '사사문구(영문)'];

  for (const { sheetName, rows } of allSheets) {
    if (SKIP_TABS.has(sheetName)) continue;
    if (rows.length < 1) continue;

    // 세로 key-value 맵 구성 (A열=항목명, B열=값). 빈 키-값은 무시.
    const kv: Record<string, string> = {};
    for (const row of rows) {
      const key   = row[0]?.trim();
      const value = row[1]?.trim();
      if (key && value) kv[key] = value;
    }

    if (Object.keys(kv).length === 0) continue;

    const acknowledgmentKo = kv['사사문구(국문)'] || undefined;
    const acknowledgmentEn = kv['사사문구(영문)'] || undefined;

    // 사사문구 외 모든 key-value → metadata.detailFields (목표/마일스톤/담당/노트 등 자동 보존)
    const detailFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(kv)) {
      if (ACK_KEYS.includes(k)) continue;
      detailFields[k] = v;
    }

    // 1단계가 만든 Project와 매칭 — 정확 일치 → 정규화 일치 → 부분 일치
    const project = await findMatchingProjectForSheet(labId, sheetName);

    const md = (project?.metadata as Record<string, unknown> | null) || {};
    const newMd = { ...md, detailFields };

    if (project) {
      // 매칭 성공: 1단계 row에 detailFields/사사문구 추가. shortName은 비어있을 때만 sheetName으로 채움.
      await prisma.project.update({
        where: { id: project.id },
        data: {
          shortName: project.shortName || sheetName,
          acknowledgmentKo,
          acknowledgmentEn,
          metadata: newMd as any,
          syncedAt: new Date(),
        },
      });
      synced++;
    } else {
      // 매칭 실패 — 신규 생성하지 않고 orphan으로 로그만 남긴다 (1단계 row 분산 방지).
      // 사용자가 시트 탭명을 1단계 과제명/사업명/단축명과 맞추면 다음 sync에서 자동 매칭.
      console.warn(`[gdrive] 시트 탭 "${sheetName}" — 1단계 Project 매칭 실패 (orphan, 신규 생성 안 함)`);
    }
  }

  return synced;
}

// ── 시트 탭명 ↔ Project 매칭 ────────────────────────────────────
//
// 매칭 우선순위:
//  1) shortName 정확 일치
//  2) businessName 정확 일치
//  3) name 정확 일치
//  4) 정규화(공백/괄호/특수문자 제거 + 소문자) 후 일치
//  5) 정규화 후 startsWith / contains (시트 탭명이 짧아서 1단계의 긴 name 안에 포함되는 케이스)

function normalizeProjectName(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, '').replace(/[\(\)\[\]\.\,\-_]/g, '');
}

async function findMatchingProjectForSheet(labId: string, sheetName: string) {
  // 1~3순위: 정확 일치
  const exact = await prisma.project.findFirst({
    where: {
      labId,
      OR: [
        { shortName: sheetName },
        { businessName: sheetName },
        { name: sheetName },
      ],
    },
  });
  if (exact) return exact;

  // 4~5순위: 정규화 후 메모리 검색
  const norm = normalizeProjectName(sheetName);
  if (!norm) return null;

  const all = await prisma.project.findMany({
    where: { labId },
    select: { id: true, name: true, shortName: true, businessName: true },
  });

  for (const p of all) {
    const ns = normalizeProjectName(p.shortName);
    const nb = normalizeProjectName(p.businessName);
    const nn = normalizeProjectName(p.name);
    if (
      (ns && ns === norm) ||
      (nb && nb === norm) ||
      (nn && nn === norm) ||
      (nn && norm.length >= 4 && nn.startsWith(norm)) ||
      (nn && norm.length >= 4 && nn.includes(norm)) ||
      (nb && norm.length >= 4 && nb.includes(norm))
    ) {
      return prisma.project.findUnique({ where: { id: p.id } });
    }
  }
  return null;
}

// ── 과제 사사 동기화 ──────────────────────────────────────────
//
// 구조:
//   행1 = 연도 라벨 ("2025")
//   행2 = 실제 헤더 (논문제목/저널명/게재일/저자/사사과제1/2/3 등)
//   행3~ = 데이터
//
// 탭: 논문 | 특허 | 학회

async function syncAcknowledgments(labId: string): Promise<number> {
  if (!env.GDRIVE_FILE_ACKNOWLEDGMENT) return 0;
  const allSheets = await readAllSheets(env.GDRIVE_FILE_ACKNOWLEDGMENT);
  let synced = 0;

  // 매번 재동기화: 기존 데이터 삭제 후 재삽입
  await prisma.acknowledgment.deleteMany({ where: { labId } });

  for (const { sheetName, rows } of allSheets) {
    // 행1 = 연도 라벨, 행2 = 헤더, 행3~ = 데이터 → 최소 3행 필요
    if (rows.length < 3) continue;

    const headers = rows[1].map(h => h.trim());
    const col = (keyword: string) =>
      headers.findIndex(h => h.includes(keyword));

    const type = sheetName; // 논문 | 특허 | 학회

    // 탭별 제목 컬럼
    const titleIdx =
      type === '특허'  ? col('특허명') :
      type === '학회'  ? col('논문명') :
      /* 논문 */         col('논문제목') >= 0 ? col('논문제목') : col('논문명');

    if (titleIdx < 0) continue;

    const authorIdx =
      type === '특허' ? col('발명자') : col('저자');

    // 사사과제 컬럼 (사사과제1, 사사과제2, 사사과제3 …)
    const projectCols = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.includes('사사과제'))
      .map(({ i }) => i);

    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      const title = row[titleIdx]?.trim();
      if (!title) continue;

      const acknowledgedProjects = projectCols
        .map(idx => row[idx]?.trim())
        .filter(Boolean);

      let journal: string | undefined;
      let publishedAt: string | undefined;
      let patentNumber: string | undefined;

      if (type === '논문') {
        journal     = row[col('저널명')]?.trim() || undefined;
        publishedAt = row[col('게재일')]?.trim() || undefined;
      } else if (type === '특허') {
        patentNumber = row[col('출원번호')]?.trim() || undefined;
        publishedAt  = row[col('출원일')]?.trim() || undefined;
      } else if (type === '학회') {
        const parts = [
          row[col('학회명')]?.trim(),
          row[col('개최지')]?.trim(),
          row[col('국내/국제')]?.trim(),
          row[col('구두/포스터')]?.trim(),
        ].filter(Boolean);
        journal     = parts.join(' | ') || undefined;
        publishedAt = row[col('발표일')]?.trim() || undefined;
      }

      await prisma.acknowledgment.create({
        data: {
          labId,
          type,
          paperTitle: title,
          authors:    authorIdx >= 0 ? row[authorIdx]?.trim() || undefined : undefined,
          acknowledgedProjects:
            acknowledgedProjects.length > 0
              ? JSON.stringify(acknowledgedProjects)
              : undefined,
          journal,
          publishedAt,
          patentNumber,
          gdriveRowIndex: i,
          syncedAt: new Date(),
        },
      });
      synced++;
    }
  }

  return synced;
}

// ── 인적사항 동기화 ───────────────────────────────────────────

async function syncMemberInfo(labId: string): Promise<number> {
  if (!env.GDRIVE_FILE_MEMBER_INFO) return 0;
  const allSheets = await readAllSheets(env.GDRIVE_FILE_MEMBER_INFO);

  // 매번 재동기화: 기존 데이터 삭제 후 일괄 삽입
  await prisma.memberInfo.deleteMany({ where: { labId } });

  const records: any[] = [];

  for (const { rows } of allSheets) {
    if (rows.length < 2) continue;
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const nameIdx = headers.findIndex(h => h.includes('이름') || h === 'name');
    if (nameIdx === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = row[nameIdx]?.trim();
      if (!name) continue;

      const joinYearStr = row[headers.findIndex(h => h.includes('입학') || h.includes('join'))]?.trim();
      const joinYear = joinYearStr ? parseInt(joinYearStr) : undefined;

      const gradYearStr = row[headers.findIndex(h => h.includes('졸업') || h.includes('grad'))]?.trim();
      const graduationYear = gradYearStr ? parseInt(gradYearStr) : undefined;

      records.push({
        labId,
        name,
        studentId:      row[headers.findIndex(h => h.includes('학번'))]?.trim() || undefined,
        researcherId:   row[headers.findIndex(h => h.includes('연구자'))]?.trim() || undefined,
        department:     row[headers.findIndex(h => h.includes('학과') || h.includes('소속'))]?.trim() || undefined,
        degree:         row[headers.findIndex(h => h.includes('구분') || h.includes('과정'))]?.trim() || undefined,
        email:          row[headers.findIndex(h => h.includes('이메일') || h.includes('email'))]?.trim() || undefined,
        phone:          row[headers.findIndex(h => h.includes('핸드폰') || h.includes('전화') || h.includes('phone'))]?.trim() || undefined,
        joinYear:       joinYear && !isNaN(joinYear) ? joinYear : undefined,
        graduationYear: graduationYear && !isNaN(graduationYear) ? graduationYear : undefined,
        bankName:       row[headers.findIndex(h => h.includes('은행') || h.includes('bank'))]?.trim() || undefined,
        accountNumber:  row[headers.findIndex(h => h.includes('계좌') || h.includes('account'))]?.trim() || undefined,
        gdriveRowIndex: i,
        syncedAt: new Date(),
      });
    }
  }

  if (records.length > 0) {
    await prisma.memberInfo.createMany({ data: records });
  }
  return records.length;
}

// ── 계정 정보 동기화 ─────────────────────────────────────────────
//
// 시트 구조: 탭별로 분류 (저널, 학회, 기타 등)
// 헤더 행: 서비스명 | URL | 아이디 | 비밀번호 | 메모

export async function syncLabAccounts(labId: string): Promise<number> {
  if (!env.GDRIVE_FILE_ACCOUNTS) {
    throw new Error('GDRIVE_FILE_ACCOUNTS 환경변수가 설정되지 않았습니다.');
  }

  const allSheets = await readGoogleSheets(env.GDRIVE_FILE_ACCOUNTS);

  // 기존 데이터 삭제 후 재삽입
  await prisma.labAccount.deleteMany({ where: { labId } });

  const records: any[] = [];

  for (const { sheetName, rows } of allSheets) {
    if (rows.length < 2) continue;
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const serviceIdx = headers.findIndex(
      h => h.includes('서비스') || h.includes('시스템') || h.includes('계정') || h === 'service',
    );

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const service = (serviceIdx >= 0 ? row[serviceIdx] : row[0])?.trim();
      if (!service) continue;

      records.push({
        labId,
        service:     `[${sheetName}] ${service}`,
        url:         row[headers.findIndex(h => h.includes('url') || h.includes('주소'))]?.trim() || undefined,
        username:    row[headers.findIndex(h => h.includes('아이디') || h === 'id' || h.includes('username'))]?.trim() || undefined,
        passwordEnc: row[headers.findIndex(h => h.includes('비밀번호') || h.includes('password'))]?.trim() || undefined,
        notes:       row[headers.findIndex(h => h.includes('메모') || h.includes('비고'))]?.trim() || undefined,
        gdriveRowIndex: i,
        syncedAt: new Date(),
      });
    }
  }

  if (records.length > 0) {
    await prisma.labAccount.createMany({ data: records });
  }

  console.log(`[gdrive] 계정 정보 ${records.length}건 동기화 완료`);
  return records.length;
}
