/**
 * Semantic consolidation helpers
 *
 * LLM consolidation: 서로 충돌할 수 있는 자연어 규칙/지침에만 사용
 *   - consolidateInstructions: 자유 텍스트 지침 배열
 *   - consolidateImportanceRules: 이메일 중요도 규칙 객체 배열
 *
 * 단순 정규화: 중복만 막으면 되는 키워드 배열에 사용 (LLM 불필요)
 *   - deduplicateKeywords: 대소문자/공백 정규화 후 중복 제거
 */
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ── 자연어 지침 통합 ─────────────────────────────────────────────────────

export async function consolidateInstructions(
  existing: string[],
  newInstruction: string,
): Promise<string[]> {
  if (existing.length === 0) return [newInstruction];

  const prompt = `당신은 지침 목록을 관리하는 시스템입니다.

기존 지침 목록:
${existing.map((inst, i) => `${i + 1}. ${inst}`).join('\n')}

새로 추가할 지침:
"${newInstruction}"

위 지침들을 아래 규칙에 따라 통합하세요:
1. 새 지침이 기존 지침과 충돌하면 새 지침으로 교체
2. 의미가 중복되면 더 구체적인 것 하나만 유지
3. 충돌/중복 없으면 기존 목록에 추가
4. 각 지침은 간결하고 명확하게 유지
5. JSON 배열로만 응답 (다른 설명 없이)

응답 형식 예시: ["지침1", "지침2", "지침3"]`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        return parsed;
      }
    }
  } catch { /* fallback */ }

  return [...existing, newInstruction];
}

// ── 이메일 중요도 규칙 통합 ───────────────────────────────────────────────

export interface ImportanceRule {
  condition: string;
  action: string;
  description?: string;
}

export async function consolidateImportanceRules(
  existing: ImportanceRule[],
  newRule: ImportanceRule,
): Promise<ImportanceRule[]> {
  if (existing.length === 0) return [newRule];

  const prompt = `당신은 이메일 중요도 규칙 목록을 관리하는 시스템입니다.
각 규칙은 { condition: "적용 조건", action: "중요도 변경 액션" } 형태입니다.

기존 규칙 목록:
${existing.map((r, i) => `${i + 1}. 조건: "${r.condition}" → 액션: "${r.action}"${r.description ? ` (${r.description})` : ''}`).join('\n')}

새로 추가할 규칙:
조건: "${newRule.condition}" → 액션: "${newRule.action}"${newRule.description ? ` (${newRule.description})` : ''}

아래 규칙에 따라 통합하세요:
1. 새 규칙의 조건이 기존 규칙 조건과 같거나 유사하면 새 규칙으로 교체
2. 같은 조건인데 액션이 다르면 새 규칙 우선
3. 명백히 다른 조건이면 기존 목록에 추가
4. JSON 배열로만 응답 (다른 설명 없이), 각 항목은 { "condition": "...", "action": "..."} 형태

응답 형식 예시: [{"condition":"조건1","action":"액션1"},{"condition":"조건2","action":"액션2"}]`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.every((r: any) => typeof r.condition === 'string' && typeof r.action === 'string')) {
        return parsed as ImportanceRule[];
      }
    }
  } catch { /* fallback */ }

  return [...existing, newRule];
}

// ── 키워드 정규화 dedup (LLM 불필요) ─────────────────────────────────────

/**
 * 키워드 배열에 새 항목을 추가할 때 사용.
 * 대소문자, 앞뒤 공백을 정규화한 후 완전 중복만 제거.
 * 의미적 유사성(ML vs machine learning)은 처리하지 않음 —
 * 키워드는 "모순"이 없으므로 LLM consolidation 불필요.
 */
export function deduplicateKeywords(existing: string[], newKeywords: string[]): string[] {
  const normalize = (s: string) => s.trim().toLowerCase();
  const existingNorm = new Set(existing.map(normalize));
  const toAdd = newKeywords.filter(kw => !existingNorm.has(normalize(kw)));
  return [...existing, ...toAdd];
}
