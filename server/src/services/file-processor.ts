/**
 * 파일 처리 서비스 — 업로드된 파일 타입별 자동 처리
 *
 * PDF  → 텍스트 추출 + 논문 판별
 * Excel → 행/열 파싱 + 구조 인식
 * 이미지 → Gemini Vision OCR
 * Word → 텍스트 추출
 */

import { env } from '../config/env.js';

export type FileType = 'pdf' | 'excel' | 'image' | 'word' | 'text' | 'unknown';

export interface ProcessedFile {
  type: FileType;
  filename: string;
  text: string;           // 추출된 텍스트
  structured?: any;       // Excel: 파싱된 행/열 데이터
  suggestedAction: string; // AI가 제안하는 액션
  metadata?: Record<string, any>;
}

export function detectFileType(mimetype: string, filename: string): FileType {
  if (mimetype === 'application/pdf' || filename.endsWith('.pdf')) return 'pdf';
  if (mimetype.includes('spreadsheet') || mimetype.includes('excel') || filename.match(/\.xlsx?$/)) return 'excel';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.includes('word') || filename.match(/\.docx?$/)) return 'word';
  if (mimetype.startsWith('text/') || filename.match(/\.(txt|md|csv)$/)) return 'text';
  return 'unknown';
}

/**
 * PDF 텍스트 추출 (Gemini Vision — PDF를 이미지로 처리)
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } },
          { text: '이 PDF의 전체 텍스트를 빠짐없이 추출하세요. 제목, 저자, 초록, 본문, 참고문헌 순서로 정리하세요. 내용을 요약하거나 생략하지 말고 원문 그대로 추출하세요. 텍스트만 출력:' },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
    });
    return result.response.text().trim();
  } catch (err) {
    console.warn('PDF extraction failed:', err);
    return '';
  }
}

/**
 * Excel 파싱 (CSV 변환 후 구조 인식)
 */
async function parseExcel(buffer: Buffer): Promise<{ text: string; structured: any }> {
  try {
    // Gemini에게 Excel 바이너리를 직접 분석하게 함
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } },
          { text: `이 Excel 파일의 내용을 분석하세요.

1. 먼저 전체 내용을 텍스트로 정리
2. 그 다음 JSON으로 구조화:
{
  "headers": ["컬럼1", "컬럼2", ...],
  "rows": [{"컬럼1": "값", "컬럼2": "값"}, ...],
  "dataType": "project|member|publication|schedule|financial|other",
  "summary": "이 데이터가 무엇인지 한 줄 설명"
}

텍스트와 JSON을 ---로 구분하여 출력:
[텍스트]
---
[JSON]` },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
    });

    const output = result.response.text().trim();
    const parts = output.split('---');
    const text = parts[0]?.trim() || '';
    let structured: any = null;
    if (parts[1]) {
      const jsonMatch = parts[1].match(/\{[\s\S]*\}/);
      if (jsonMatch) structured = JSON.parse(jsonMatch[0]);
    }
    return { text, structured };
  } catch (err) {
    console.warn('Excel parsing failed:', err);
    return { text: '', structured: null };
  }
}

/**
 * 이미지 OCR + 내용 인식 (Gemini Vision)
 */
async function processImage(buffer: Buffer, mimetype: string): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType: mimetype } },
          { text: '이 이미지의 내용을 상세히 설명하세요. 텍스트가 있으면 모두 추출하세요. 영수증이면 날짜/금액/장소를 정리하세요. 실험 데이터면 측정값을 정리하세요.' },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    });
    return result.response.text().trim();
  } catch (err) {
    console.warn('Image processing failed:', err);
    return '';
  }
}

/**
 * 파일 처리 메인 함수
 */
export async function processUploadedFile(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<ProcessedFile> {
  const type = detectFileType(mimetype, filename);

  switch (type) {
    case 'pdf': {
      const text = await extractPdfText(buffer);
      // 논문인지 판별
      const isPaper = /abstract|introduction|conclusion|references|doi/i.test(text.slice(0, 2000));
      return {
        type, filename, text,
        suggestedAction: isPaper
          ? 'paper_discuss'   // 논문 토론 모드
          : 'document_summarize', // 일반 문서 요약
        metadata: { isPaper, pageEstimate: Math.ceil(buffer.length / 3000) },
      };
    }

    case 'excel': {
      const { text, structured } = await parseExcel(buffer);
      const dataType = structured?.dataType || 'other';
      const actionMap: Record<string, string> = {
        project: 'import_projects',
        member: 'import_members',
        publication: 'import_publications',
        schedule: 'import_calendar',
        financial: 'import_financial',
      };
      return {
        type, filename, text, structured,
        suggestedAction: actionMap[dataType] || 'data_review',
        metadata: { dataType, rowCount: structured?.rows?.length || 0 },
      };
    }

    case 'image': {
      const text = await processImage(buffer, mimetype);
      const isReceipt = /영수증|금액|합계|카드|결제|total|amount/i.test(text);
      return {
        type, filename, text,
        suggestedAction: isReceipt ? 'receipt_process' : 'image_memo',
        metadata: { isReceipt },
      };
    }

    case 'word': {
      // Word도 Gemini에게 직접 처리
      const text = await extractPdfText(buffer); // PDF와 같은 방식
      return {
        type, filename, text,
        suggestedAction: 'document_review',
      };
    }

    case 'text': {
      const text = buffer.toString('utf-8');
      return { type, filename, text, suggestedAction: 'text_process' };
    }

    default:
      return { type: 'unknown', filename, text: '', suggestedAction: 'unsupported' };
  }
}
