/**
 * Google Docs 생성 서비스 — 회의록, 브리핑, 보고서를 Google Docs로 생성
 *
 * 기존 Gmail OAuth 토큰(drive.file 스코프)을 재사용하여
 * 유저의 Google Drive에 문서를 생성/업데이트.
 */

import { google } from 'googleapis';
import { basePrismaClient } from '../config/prisma.js';
import { env } from '../config/env.js';
import { encryptToken, decryptToken, isEncrypted } from '../utils/crypto.js';

function safeDecrypt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { return isEncrypted(value) ? decryptToken(value) : value; } catch { return value; }
}

function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * 유저의 Google OAuth 클라이언트를 가져옴 (Gmail 토큰 재사용)
 */
async function getAuthClient(userId: string) {
  const token = await basePrismaClient.gmailToken.findFirst({
    where: { userId },
    orderBy: { primary: 'desc' },
  });
  if (!token) throw new Error('Google 연동이 필요합니다');

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: safeDecrypt(token.accessToken),
    refresh_token: safeDecrypt(token.refreshToken),
    expiry_date: token.expiresAt?.getTime(),
  });

  // 토큰 자동 갱신 시 DB 업데이트 (암호화하여 저장)
  oauth2Client.on('tokens', async (tokens) => {
    try {
      await basePrismaClient.gmailToken.update({
        where: { id: token.id },
        data: {
          accessToken: encryptToken(tokens.access_token!),
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
        },
      });
    } catch { /* ignore */ }
  });

  return oauth2Client;
}

/**
 * Google Docs 생성 — 마크다운 형태의 텍스트를 Google Docs로 변환
 */
export async function createGoogleDoc(
  userId: string,
  title: string,
  content: string,
  folderId?: string,
): Promise<{ docId: string; docUrl: string }> {
  const auth = await getAuthClient(userId);
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // 1. 빈 문서 생성
  const doc = await docs.documents.create({
    requestBody: { title },
  });
  const docId = doc.data.documentId!;

  // 2. 폴더로 이동 (지정된 경우)
  if (folderId) {
    try {
      await drive.files.update({
        fileId: docId,
        addParents: folderId,
        fields: 'id, parents',
      });
    } catch { /* 폴더 이동 실패는 무시 */ }
  }

  // 3. 콘텐츠 삽입 (Docs API batch update)
  const requests = buildDocRequests(content);
  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests },
    });
  }

  return {
    docId,
    docUrl: `https://docs.google.com/document/d/${docId}/edit`,
  };
}

/**
 * 미팅 요약을 Google Docs로 생성
 */
export async function createMeetingDoc(
  userId: string,
  meeting: {
    title: string;
    agenda: string[];
    discussions: Array<{ topic: string; content: string }>;
    actionItems: string[];
    nextSteps: string[];
    transcription?: string;
    date?: string;
  },
): Promise<{ docId: string; docUrl: string }> {
  const date = meeting.date || new Date().toISOString().split('T')[0];
  const title = `회의록: ${meeting.title} (${date})`;

  const sections: string[] = [
    `회의록: ${meeting.title}`,
    `날짜: ${date}\n`,
  ];

  if (meeting.agenda.length > 0) {
    sections.push('안건');
    sections.push(meeting.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n'));
  }

  if (meeting.discussions.length > 0) {
    sections.push('\n논의 내용');
    for (const d of meeting.discussions) {
      sections.push(`▸ ${d.topic}\n  ${d.content}`);
    }
  }

  if (meeting.actionItems.length > 0) {
    sections.push('\n액션 아이템');
    sections.push(meeting.actionItems.map(a => `• ${a}`).join('\n'));
  }

  if (meeting.nextSteps.length > 0) {
    sections.push('\n다음 할 일');
    sections.push(meeting.nextSteps.map(n => `• ${n}`).join('\n'));
  }

  // 전사 원문은 Google Docs에 포함하지 않음 (너무 길고 불필요)

  const content = sections.join('\n\n');
  return createGoogleDoc(userId, title, content);
}

/**
 * 이메일 브리핑을 Google Docs로 생성
 */
export async function createBriefingDoc(
  userId: string,
  briefingData: {
    date: string;
    emails: Array<{ group?: string; groupEmoji?: string; category: string; categoryEmoji: string; subject: string; sender: string; summary: string }>;
  },
): Promise<{ docId: string; docUrl: string }> {
  const title = `이메일 브리핑 ${briefingData.date}`;
  const lines: string[] = [`이메일 브리핑 — ${briefingData.date}`, ''];

  // 그룹별 정리
  const grouped: Record<string, typeof briefingData.emails> = {};
  for (const email of briefingData.emails) {
    const group = email.group || '기타';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(email);
  }

  for (const [group, emails] of Object.entries(grouped)) {
    const emoji = emails[0]?.groupEmoji || '[mail]';
    lines.push(`${emoji} ${group} (${emails.length}건)`);
    lines.push('─'.repeat(20));
    for (const e of emails) {
      lines.push(`${e.categoryEmoji} ${e.subject}`);
      lines.push(`  ${e.sender} — ${e.summary}`);
    }
    lines.push('');
  }

  return createGoogleDoc(userId, title, lines.join('\n'));
}

// ── Docs API 요청 빌더 (텍스트 → insertText requests) ──
function buildDocRequests(content: string) {
  // 간단한 구현: 전체 텍스트를 한번에 삽입
  // (Docs API는 index 1부터 시작 — 문서 시작)
  if (!content.trim()) return [];
  return [
    {
      insertText: {
        location: { index: 1 },
        text: content,
      },
    },
  ];
}
