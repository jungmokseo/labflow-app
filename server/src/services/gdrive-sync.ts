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

async function readAllSheets(fileId: string): Promise<SheetData[]> {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const fileMeta = await drive.files.get({ fileId, fields: 'mimeType,name' });
  const mimeType = fileMeta.data.mimeType || '';
  console.log(`  파일: "${fileMeta.data.name}" (${mimeType.split('.').pop()})`);

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

  // 1단계: "과제 정보" 탭 → 과제 목록 upsert
  const mainSheet = allSheets.find(s => s.sheetName === '과제 정보');
  if (mainSheet && mainSheet.rows.length >= 2) {
    const headers = mainSheet.rows[0].map(h => h.trim());
    const col = (keyword: string) =>
      headers.findIndex(h => h.includes(keyword));

    for (let i = 1; i < mainSheet.rows.length; i++) {
      const row = mainSheet.rows[i];
      const name = row[col('과제명')]?.trim();
      if (!name) continue;

      const data = {
        businessName:   row[col('사업명')]?.trim() || undefined,
        ministry:       row[col('과제수행부처')]?.trim() || undefined,
        funder:         row[col('전문기관명')]?.trim() || undefined,
        period:         row[col('과제기간')]?.trim() || row[col('기간')]?.trim() || undefined,
        pm:             row[col('담당자')]?.trim() || row[col('담당')]?.trim() || undefined,
        responsibility: row[col('3책')]?.trim() || undefined,
        gdriveRowIndex: i,
        syncedAt: new Date(),
      };

      await prisma.project.upsert({
        where: { labId_name: { labId, name } },
        update: data,
        create: { labId, name, ...data },
      });
      synced++;
    }
  }

  // 2단계: 나머지 탭들 → 사사문구 추출 후 Project에 업데이트
  const SKIP_TABS = new Set(['과제 정보', '참여율', '초격차산업', '미답변 질문']);

  for (const { sheetName, rows } of allSheets) {
    if (SKIP_TABS.has(sheetName)) continue;
    if (rows.length < 1) continue;

    // 세로 key-value 맵 구성 (A열=항목명, B열=값)
    const kv: Record<string, string> = {};
    for (const row of rows) {
      const key   = row[0]?.trim();
      const value = row[1]?.trim();
      if (key && value) kv[key] = value;
    }

    const acknowledgmentKo = kv['사사문구(국문)'] || undefined;
    const acknowledgmentEn = kv['사사문구(영문)'] || undefined;
    if (!acknowledgmentKo && !acknowledgmentEn) continue;

    // 기존 Project 찾기: shortName 또는 businessName이 탭명과 일치하는 것 우선
    let project = await prisma.project.findFirst({
      where: { labId, shortName: sheetName },
    });
    if (!project) {
      project = await prisma.project.findFirst({
        where: { labId, businessName: sheetName },
      });
    }

    if (project) {
      await prisma.project.update({
        where: { id: project.id },
        data: { shortName: sheetName, acknowledgmentKo, acknowledgmentEn, syncedAt: new Date() },
      });
    } else {
      // 과제 정보 탭에 없는 경우 단축명으로 신규 생성
      await prisma.project.upsert({
        where: { labId_name: { labId, name: sheetName } },
        update: { shortName: sheetName, acknowledgmentKo, acknowledgmentEn, syncedAt: new Date() },
        create: { labId, name: sheetName, shortName: sheetName, acknowledgmentKo, acknowledgmentEn, syncedAt: new Date() },
      });
    }
    synced++;
  }

  return synced;
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
