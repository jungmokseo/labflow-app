/* eslint-disable no-misleading-character-class */

// Runtime regex with unicode flag — TypeScript target=es5 doesn't support 'u' flag at type level
// but Next.js transpiles to modern JS at runtime, so this works fine.
const EMOJI_RE = new RegExp(
  '[\\u{1F300}-\\u{1F9FF}]|[\\u{2600}-\\u{26FF}]|[\\u{2700}-\\u{27BF}]|[\\u{1F000}-\\u{1F2FF}]|[\\u{1F600}-\\u{1F64F}]|[\\u{1F680}-\\u{1F6FF}]|[\\u{1FA00}-\\u{1FAFF}]|[\\u{2300}-\\u{23FF}]|[\\u{200D}]|[\\u{FE0F}]',
  'gu',
);

const SYMBOL_RE = /[★☆▶◀▲▼]/g;
const MULTI_SPACE_RE = /\s{2,}/g;

export function stripEmoji(text: string): string {
  return text
    .replace(EMOJI_RE, '')
    .replace(SYMBOL_RE, '')
    .replace(MULTI_SPACE_RE, ' ')
    .trim();
}
