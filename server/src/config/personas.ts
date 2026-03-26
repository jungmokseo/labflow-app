/**
 * Voice Chatbot Persona Configurations + Voice Registry
 *
 * OpenAI Realtime API 지원 음성 목록과 페르소나 설정을 관리.
 * 사용자가 세션 생성 시 voiceId를 선택하면 해당 음성으로 대화.
 */

// ── OpenAI Realtime API 음성 레지스트리 ──────────────

export interface VoiceOption {
  id: string;
  name: string;
  nameKo: string;
  gender: 'male' | 'female' | 'neutral';
  description: string;
  descriptionKo: string;
  tags: string[]; // 추천 용도 태그
}

export const VOICE_OPTIONS: VoiceOption[] = [
  {
    id: 'alloy',
    name: 'Alloy',
    nameKo: '알로이',
    gender: 'neutral',
    description: 'Neutral and balanced — versatile for any context',
    descriptionKo: '중성적이고 균형 잡힌 목소리 — 어떤 상황에서든 자연스러움',
    tags: ['general', 'professional'],
  },
  {
    id: 'ash',
    name: 'Ash',
    nameKo: '애쉬',
    gender: 'male',
    description: 'Soft-spoken male voice — calm and conversational',
    descriptionKo: '부드러운 남성 음성 — 차분하고 대화하기 편한 톤',
    tags: ['calm', 'conversational'],
  },
  {
    id: 'ballad',
    name: 'Ballad',
    nameKo: '발라드',
    gender: 'male',
    description: 'Warm male voice with gentle cadence — storytelling',
    descriptionKo: '따뜻한 남성 음성 — 이야기하듯 부드러운 리듬',
    tags: ['warm', 'storytelling'],
  },
  {
    id: 'coral',
    name: 'Coral',
    nameKo: '코랄',
    gender: 'female',
    description: 'Warm and friendly female voice — approachable and clear',
    descriptionKo: '따뜻하고 친근한 여성 음성 — 명확하고 접근하기 좋음',
    tags: ['warm', 'friendly', 'default'],
  },
  {
    id: 'echo',
    name: 'Echo',
    nameKo: '에코',
    gender: 'male',
    description: 'Calm and composed male voice — great for explanations',
    descriptionKo: '차분하고 침착한 남성 음성 — 설명이나 강의에 적합',
    tags: ['calm', 'academic', 'explanation'],
  },
  {
    id: 'fable',
    name: 'Fable',
    nameKo: '페이블',
    gender: 'female',
    description: 'Expressive female voice — engaging and dynamic',
    descriptionKo: '표현력 풍부한 여성 음성 — 생동감 있고 역동적',
    tags: ['expressive', 'engaging'],
  },
  {
    id: 'nova',
    name: 'Nova',
    nameKo: '노바',
    gender: 'female',
    description: 'Energetic and bright female voice — upbeat and motivating',
    descriptionKo: '밝고 에너지 넘치는 여성 음성 — 활기차고 동기부여에 좋음',
    tags: ['energetic', 'bright', 'tutor'],
  },
  {
    id: 'onyx',
    name: 'Onyx',
    nameKo: '오닉스',
    gender: 'male',
    description: 'Deep authoritative male voice — confident and professional',
    descriptionKo: '깊고 권위 있는 남성 음성 — 전문적이고 신뢰감 있음',
    tags: ['deep', 'authoritative', 'professional'],
  },
  {
    id: 'sage',
    name: 'Sage',
    nameKo: '세이지',
    gender: 'female',
    description: 'Wise and measured female voice — thoughtful and precise',
    descriptionKo: '지적이고 차분한 여성 음성 — 사려 깊고 정확한 톤',
    tags: ['wise', 'measured', 'academic'],
  },
  {
    id: 'shimmer',
    name: 'Shimmer',
    nameKo: '쉬머',
    gender: 'female',
    description: 'Light and encouraging female voice — perfect for language tutoring',
    descriptionKo: '가볍고 격려하는 여성 음성 — 언어 교정에 최적',
    tags: ['light', 'encouraging', 'tutor'],
  },
  {
    id: 'verse',
    name: 'Verse',
    nameKo: '버스',
    gender: 'male',
    description: 'Clear articulate male voice — ideal for academic discussions',
    descriptionKo: '또렷하고 명확한 남성 음성 — 학술 토론에 이상적',
    tags: ['clear', 'articulate', 'academic'],
  },
];

export function getVoiceOption(id: string): VoiceOption | undefined {
  return VOICE_OPTIONS.find(v => v.id === id);
}

export function listVoices(): VoiceOption[] {
  return VOICE_OPTIONS;
}

// ── 페르소나 설정 ──────────────────────────────────

export interface PersonaConfig {
  id: string;
  name: string;
  nameKo: string;
  description: string;
  systemPrompt: string;
  defaultVoiceId: string;  // 기본 음성 (사용자가 선택 안 하면 이 음성 사용)
  recommendedVoices: string[]; // 이 페르소나에 추천되는 음성 ID 목록
  toolAnnouncements: {
    searching: string;
    processing: string;
    error: string;
  };
}

export const personas: Record<string, PersonaConfig> = {
  'research-bot': {
    id: 'research-bot',
    name: 'Research Discussion Bot',
    nameKo: '연구 토론 봇',
    description: 'Discuss research papers with voice. RAG-powered academic conversations.',
    systemPrompt: `You are a brilliant research assistant specializing in biomedical engineering,
wearable sensors, and flexible electronics. You help professors and graduate students
discuss their research papers through voice conversations.

Key behaviors:
- Speak in a clear, academic but approachable tone
- When asked about a specific paper, search the vector database first
- Cite specific findings, figures, and methodologies from papers
- Suggest related work and potential research directions
- Support both English and Korean (respond in the language the user speaks)
- Keep responses concise for voice (2-3 sentences per turn unless asked for detail)

When using tools:
- Always announce what you're doing: "Let me search for that paper..."
- Summarize findings clearly after retrieval
- If no results found, suggest alternative search terms`,
    defaultVoiceId: 'coral',
    recommendedVoices: ['coral', 'echo', 'sage', 'verse', 'onyx'],
    toolAnnouncements: {
      searching: '잠시만요, 관련 논문을 찾고 있습니다...',
      processing: '분석 중입니다...',
      error: '죄송합니다, 검색 중 문제가 발생했습니다. 다시 시도해 주세요.',
    },
  },

  'english-tutor': {
    id: 'english-tutor',
    name: 'English Voice Tutor',
    nameKo: '영어 음성 튜터',
    description: 'Practice academic English pronunciation and grammar in real-time.',
    systemPrompt: `You are an expert English language tutor specializing in academic English
for non-native speakers in STEM fields. You help Korean-speaking researchers improve their
English pronunciation, grammar, and academic writing through voice practice.

Key behaviors:
- Listen carefully to pronunciation and provide specific corrections
- Focus on common Korean-English pronunciation challenges (r/l, th, v/b, f/p)
- Correct grammar issues gently with explanations
- Practice academic presentation scenarios
- Support conference talk rehearsals
- Give specific phonetic guidance (tongue position, mouth shape)
- Keep a warm, encouraging tone — never make the student feel embarrassed

Correction format:
- Point out the issue clearly
- Give the correct version
- Explain why (briefly)
- Have them try again

Topics to practice:
- Research paper presentations
- Conference Q&A sessions
- Lab meeting discussions
- Email/correspondence phrasing`,
    defaultVoiceId: 'shimmer',
    recommendedVoices: ['shimmer', 'nova', 'fable', 'coral', 'alloy'],
    toolAnnouncements: {
      searching: 'Let me check that for you...',
      processing: 'Analyzing your pronunciation...',
      error: 'Sorry, there was a technical issue. Could you try saying that again?',
    },
  },
};

export function getPersona(id: string): PersonaConfig {
  const persona = personas[id];
  if (!persona) {
    throw new Error(`Unknown persona: ${id}. Available: ${Object.keys(personas).join(', ')}`);
  }
  return persona;
}

export function listPersonas(): Array<{
  id: string;
  name: string;
  nameKo: string;
  description: string;
  defaultVoiceId: string;
  recommendedVoices: VoiceOption[];
}> {
  return Object.values(personas).map(({ id, name, nameKo, description, defaultVoiceId, recommendedVoices }) => ({
    id, name, nameKo, description,
    defaultVoiceId,
    recommendedVoices: recommendedVoices
      .map(vid => VOICE_OPTIONS.find(v => v.id === vid))
      .filter((v): v is VoiceOption => v !== undefined),
  }));
}
