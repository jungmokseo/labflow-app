import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';
import 'dotenv/config';

export const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Notion DB IDs
export const DB_IDS = {
  members: '501ec0ca5469426491e4b3148e3ea830',
  projects: '1d58e8180da34de4b2d12bd38c390377',
  faq: '495c03f911704fa09961f49bb5c8635c',
  regulations: '7bc879e43f8f477cb679a4ab652c06a9',
  vacations: 'a3de6ce65a434b7f9f4b30a286fae5a6',
  accounts: '4e835742f14748f09e22b19ef9fe24b8',
} as const;

export async function fetchAllPages(databaseId: string): Promise<PageObjectResponse[]> {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results.filter((r): r is PageObjectResponse => 'properties' in r));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return pages;
}

// Property extractors
export function getTitle(props: any, key: string): string {
  const prop = props[key];
  if (!prop || prop.type !== 'title') return '';
  return prop.title?.map((t: any) => t.plain_text).join('') ?? '';
}

export function getRichText(props: any, key: string): string {
  const prop = props[key];
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text?.map((t: any) => t.plain_text).join('') ?? '';
}

export function getEmail(props: any, key: string): string | null {
  const prop = props[key];
  if (!prop || prop.type !== 'email') return null;
  return prop.email ?? null;
}

export function getPhoneNumber(props: any, key: string): string | null {
  const prop = props[key];
  if (!prop || prop.type !== 'phone_number') return null;
  return prop.phone_number ?? null;
}

export function getNumber(props: any, key: string): number | null {
  const prop = props[key];
  if (!prop || prop.type !== 'number') return null;
  return prop.number ?? null;
}

export function getSelect(props: any, key: string): string | null {
  const prop = props[key];
  if (!prop || prop.type !== 'select') return null;
  return prop.select?.name ?? null;
}

export function getMultiSelect(props: any, key: string): string[] {
  const prop = props[key];
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select?.map((s: any) => s.name) ?? [];
}

export function getDate(props: any, key: string): { start: string | null; end: string | null } {
  const prop = props[key];
  if (!prop || prop.type !== 'date' || !prop.date) return { start: null, end: null };
  return { start: prop.date.start ?? null, end: prop.date.end ?? null };
}

export function getPeople(props: any, key: string): string[] {
  const prop = props[key];
  if (!prop || prop.type !== 'people') return [];
  return prop.people?.map((p: any) => p.name ?? p.id) ?? [];
}

export function getCheckbox(props: any, key: string): boolean {
  const prop = props[key];
  if (!prop || prop.type !== 'checkbox') return false;
  return prop.checkbox ?? false;
}

export function getUrl(props: any, key: string): string | null {
  const prop = props[key];
  if (!prop || prop.type !== 'url') return null;
  return prop.url ?? null;
}

export function getStatus(props: any, key: string): string | null {
  const prop = props[key];
  if (!prop || prop.type !== 'status') return null;
  return prop.status?.name ?? null;
}

export function getFormula(props: any, key: string): any {
  const prop = props[key];
  if (!prop || prop.type !== 'formula') return null;
  const formula = prop.formula;
  if (formula.type === 'string') return formula.string;
  if (formula.type === 'number') return formula.number;
  if (formula.type === 'boolean') return formula.boolean;
  if (formula.type === 'date') return formula.date;
  return null;
}

export function getRollup(props: any, key: string): any {
  const prop = props[key];
  if (!prop || prop.type !== 'rollup') return null;
  const rollup = prop.rollup;
  if (rollup.type === 'number') return rollup.number;
  if (rollup.type === 'array') return rollup.array;
  return null;
}
