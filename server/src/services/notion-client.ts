/**
 * Notion Client 공용 팩토리 — global fetch(undici) 주입.
 *
 * 배경 (2026-07-13 검증): @notionhq/client 내장 node-fetch v2가 Railway 환경에서
 * keep-alive 커넥션 재사용 시 'Premature close'를 던져,
 *  - deadline-reminder cron이 2026-06-21부터 23일 연속 전건 실패
 *  - wiki-engine의 Notion 워크스페이스 수집이 매일 중단
 * 됐음. Node 18+ 의 global fetch(undici)를 주입해 node-fetch 경로를 우회한다.
 *
 * 주의: 여기서 자동 재시도는 하지 않는다 — Premature close는 응답 스트림 중단이라
 * 요청이 이미 적용됐을 수 있고, blocks.children.append 같은 비멱등 호출을 재시도하면
 * 중복이 생긴다. 재시도가 필요한 read 호출은 호출자가 개별 판단.
 */
import { Client as NotionClient } from '@notionhq/client';

export type { NotionClient };

export function createNotionClient(auth: string | undefined): NotionClient {
  return new NotionClient({
    auth,
    fetch: (url, init) => fetch(url, init as RequestInit),
  });
}
