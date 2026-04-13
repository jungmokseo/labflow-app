/**
 * consolidateInstructions — 기존 지침 목록 + 새 지침을 LLM으로 통합
 *
 * - 충돌 시 새 지침 우선
 * - 의미적 중복 제거
 * - 간결한 지침 배열로 반환
 */
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function consolidateInstructions(
  existing: string[],
  newInstruction: string,
): Promise<string[]> {
  // 기존 지침이 없으면 그냥 추가
  if (existing.length === 0) {
    return [newInstruction];
  }

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
  } catch {
    // LLM 실패 시 단순 append fallback
  }

  return [...existing, newInstruction];
}
