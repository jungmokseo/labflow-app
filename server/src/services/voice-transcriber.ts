/**
 * 음성 전사 + AI 분류 통합 서비스
 *
 * Gemini 2.5 Flash의 멀티모달(오디오) 입력을 활용하여
 * 한 번의 API 호출로 전사(STT) + 분류(카테고리/태그/우선순위)를 수행
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { ClassificationResult, classifyLocal } from './gemini-classifier.js';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

export interface VoiceTranscriptionResult extends ClassificationResult {
  transcription: string;  // 전사된 원본 텍스트
}

const VOICE_PROMPT = `당신은 연구자의 음성 메모를 처리하는 AI입니다.

다음 작업을 수행하세요:
1. 오디오를 한국어 텍스트로 전사 (필러 단어 제거, 문장 정리)
2. 전사된 텍스트를 아래 3가지 카테고리 중 하나로 분류

카테고리:
- **TASK** (할일): 기한이 있거나 실행해야 하는 액션 아이템
- **IDEA** (아이디어): 나중에 발전시킬 생각, 가설, 영감
- **MEMO** (메모): 기억해야 할 정보, 참고사항

오늘 날짜: ${new Date().toISOString().split('T')[0]}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "transcription": "전사된 텍스트 (정리된 문장)",
  "category": "TASK" | "IDEA" | "MEMO",
  "confidence": 0.0~1.0,
  "summary": "한줄 요약 (30자 이내)",
  "tags": ["관련", "태그", "최대3개"],
  "actionDate": "YYYY-MM-DD 또는 null",
  "priority": "HIGH" | "MEDIUM" | "LOW"
}`;

/**
 * 오디오 버퍼를 Gemini에 전송하여 전사 + 분류
 */
export async function transcribeAndClassify(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<VoiceTranscriptionResult> {
  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: audioBuffer.toString('base64'),
              mimeType,
            },
          },
          { text: VOICE_PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  });

  const response = result.response.text().trim();
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Gemini voice response');
  const parsed = JSON.parse(jsonMatch[0]);

  const validCategories = ['IDEA', 'TASK', 'MEMO'];
  const validPriorities = ['HIGH', 'MEDIUM', 'LOW'];

  return {
    transcription: String(parsed.transcription || '').trim(),
    category: validCategories.includes(parsed.category) ? parsed.category : 'MEMO',
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.7)),
    summary: String(parsed.summary || parsed.transcription || '').substring(0, 50),
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3) : [],
    actionDate: parsed.actionDate && parsed.actionDate !== 'null' ? parsed.actionDate : null,
    priority: validPriorities.includes(parsed.priority) ? parsed.priority : 'MEDIUM',
    modelUsed: 'gemini-flash-voice',
  };
}

/**
 * 텍스트 전사만 (분류 없이) - 간단한 STT
 */
export async function transcribeOnly(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<string> {
  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: audioBuffer.toString('base64'),
              mimeType,
            },
          },
          { text: '이 오디오를 한국어 텍스트로 전사해주세요. 필러 단어는 제거하고, 깔끔한 문장으로 정리해주세요. 전사된 텍스트만 출력하세요.' },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  });

  return result.response.text().trim();
}
