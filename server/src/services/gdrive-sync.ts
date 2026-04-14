/**
 * Google Drive 동기화 서비스 (labflow-app Brain용)
 *
 * 대상 파일:
 * - GDRIVE_FILE_ACCOUNTS → LabAccount 테이블 (계정 정보)
 *
 * 인증: GOOGLE_REFRESH_TOKEN (PI 계정 고정 토큰)
 */

import { google } from 'googleapis';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

// ── Google Auth ─────────────────────────────────────────────────

let _auth: any = null;

async function getAuth() {
  if (_auth) return _auth;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google 인증 정보가 설정되지 않았습니다. (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN 확인)');
  }
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  const { credentials } = await oauth2.refreshAccessToken();
  oauth2.setCredentials(credentials);
  console.log('[gdrive] OAuth 토큰 갱신 완료');
  google.options({ timeout: 30000 });
  _auth = oauth2;
  return _auth;
}

// 토큰 캐시 리셋 (재인증 필요 시)
export function resetAuthCache() {
  _auth = null;
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
