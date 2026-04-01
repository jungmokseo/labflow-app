/**
 * Lab Profile → Feature Sync Service
 *
 * Lab 프로필 데이터를 각 기능(이메일, 논문 모니터링 등)의 설정에 자동 동기화.
 * 유저가 온보딩에서 Lab을 설정하면, 그 정보가 이메일 분류 키워드,
 * 논문 알림, 중요도 규칙 등에 자동 반영.
 */

import { basePrismaClient } from '../config/prisma.js';

interface ResearchTheme {
  name: string;
  keywords: string[];
  journals?: string[];
}

/**
 * Lab 프로필 변경 시 EmailProfile에 자동 동기화
 *
 * - researchThemes/researchFields → keywords (중요도 상향)
 * - members → importanceRules (학생 메일 중요)
 * - institution → groups (기관별 분류)
 */
export async function syncLabToEmailProfile(userId: string, labId: string) {
  const lab = await basePrismaClient.lab.findUnique({
    where: { id: labId },
    include: {
      members: { where: { active: true } },
    },
  });
  if (!lab) return;

  // 1. 연구 키워드 수집
  const keywords: string[] = [...(lab.researchFields || [])];
  const themes = (lab.researchThemes as ResearchTheme[] | null) || [];
  for (const theme of themes) {
    keywords.push(...(theme.keywords || []));
  }
  const uniqueKeywords = [...new Set(keywords)].filter(Boolean);

  // 2. 기관 그룹 빌드 (institution 기반)
  const groups: Array<{ name: string; domains: string[]; emoji: string }> = [];
  if (lab.institution) {
    // 대학 이메일 도메인 추출 시도
    const memberDomains = lab.members
      .filter(m => m.email)
      .map(m => m.email!.split('@')[1])
      .filter(Boolean);
    const uniqueDomains = [...new Set(memberDomains)];
    if (uniqueDomains.length > 0) {
      groups.push({
        name: lab.institution,
        emoji: '🏫',
        domains: uniqueDomains,
      });
    }
  }

  // 3. 중요도 규칙 빌드 (멤버 이메일 기반)
  const importanceRules: Array<{ condition: string; action: string; description?: string }> = [];

  // 학생/멤버 메일 중요 처리
  const memberEmails = lab.members
    .filter(m => m.email && m.active)
    .map(m => m.email!);
  if (memberEmails.length > 0) {
    const domains = [...new Set(memberEmails.map(e => e.split('@')[1]).filter(Boolean))];
    if (domains.length > 0) {
      importanceRules.push({
        condition: `발신자 도메인이 ${domains.join(', ')} 이고 개인 발송 메일`,
        action: 'action-needed 이상 유지',
        description: `${lab.name} 멤버 메일 중요`,
      });
    }
  }

  // 논문/저널 Decision 규칙 (항상 추가)
  importanceRules.push(
    {
      condition: '저널/출판사 Decision, Review results, Revision 메일',
      action: 'urgent로 최우선 상향',
      description: '논문 의사결정',
    },
    {
      condition: 'Submission confirmation 메일',
      action: 'urgent로 상향',
      description: '투고 확인',
    },
    {
      condition: 'Call for Papers, 투고 초대',
      action: 'info 또는 ads로 강등',
      description: 'CfP는 정보성',
    },
  );

  // 4. 발신자 시간대 (한국 도메인)
  const senderTimezones = [
    { domains: ['.kr', 'naver.com', 'daum.net', 'kakao.com'], timezone: 'Asia/Seoul', label: 'KST' },
  ];

  // 5. EmailProfile에 동기화
  const existing = await basePrismaClient.emailProfile.findUnique({ where: { userId } });

  if (existing) {
    // 기존 프로필이 있으면 병합 (유저가 직접 설정한 것 보존)
    const existingKeywords = (existing.keywords as string[] | null) || [];
    const existingRules = (existing.importanceRules as any[] | null) || [];
    const existingGroups = (existing.groups as any[] | null) || [];

    // 기존 키워드에 Lab 키워드 병합 (중복 제거)
    const mergedKeywords = [...new Set([...existingKeywords, ...uniqueKeywords])];

    // 기존 그룹에 Lab 그룹 병합 (이름 기준 중복 제거)
    const existingGroupNames = new Set(existingGroups.map((g: any) => g.name));
    const newGroups = groups.filter(g => !existingGroupNames.has(g.name));
    const mergedGroups = [...existingGroups, ...newGroups];

    // 규칙은 description 기준으로 중복 제거
    const existingDescs = new Set(existingRules.map((r: any) => r.description));
    const newRules = importanceRules.filter(r => !existingDescs.has(r.description));
    const mergedRules = [...existingRules, ...newRules];

    await basePrismaClient.emailProfile.update({
      where: { userId },
      data: {
        keywords: mergedKeywords as any,
        groups: mergedGroups as any,
        importanceRules: mergedRules as any,
        classifyByGroup: mergedGroups.length > 0,
        ...(!(existing.senderTimezones as any[])?.length ? { senderTimezones: senderTimezones as any } : {}),
      },
    });
  } else {
    // 새 프로필 생성
    await basePrismaClient.emailProfile.create({
      data: {
        userId,
        classifyByGroup: groups.length > 0,
        groups: groups as any,
        keywords: uniqueKeywords as any,
        importanceRules: importanceRules as any,
        senderTimezones: senderTimezones as any,
        timezone: 'America/New_York',
      },
    });
  }
}

/**
 * Lab 연구 테마 → PaperAlert 자동 동기화
 */
export async function syncLabToPaperAlerts(labId: string) {
  const lab = await basePrismaClient.lab.findUnique({
    where: { id: labId },
  });
  if (!lab) return;

  const themes = (lab.researchThemes as ResearchTheme[] | null) || [];
  if (themes.length === 0 && (lab.researchFields || []).length === 0) return;

  // 기존 PaperAlert 확인
  const existingAlerts = await basePrismaClient.paperAlert.findMany({
    where: { labId },
  });

  // 테마별로 PaperAlert 생성/업데이트
  for (const theme of themes) {
    const existing = existingAlerts.find(a =>
      (a.keywords as string[]).some(k => theme.keywords.includes(k))
    );

    if (!existing) {
      await basePrismaClient.paperAlert.create({
        data: {
          labId,
          keywords: theme.keywords as any,
          journals: (theme.journals || []) as any,
          schedule: 'weekly',
          active: true,
        },
      });
    }
  }

  // researchFields에서 테마로 커버 안 되는 키워드가 있으면 통합 알림 생성
  const themeKeywords = new Set(themes.flatMap(t => t.keywords));
  const uncoveredFields = (lab.researchFields || []).filter(f => !themeKeywords.has(f));
  if (uncoveredFields.length > 0) {
    const hasGeneral = existingAlerts.some(a =>
      (a.keywords as string[]).includes(uncoveredFields[0])
    );
    if (!hasGeneral) {
      await basePrismaClient.paperAlert.create({
        data: {
          labId,
          keywords: uncoveredFields as any,
          journals: [] as any,
          schedule: 'weekly',
          active: true,
        },
      });
    }
  }
}

/**
 * Lab researchFields/researchThemes → DomainDict 자동 생성
 *
 * 연구 키워드를 기반으로 Gemini가 해당 분야 핵심 기술용어를 생성하여
 * 용어 교정 사전에 자동 추가. 이미 있는 용어는 건너뜀.
 */
async function syncLabToDomainDict(labId: string) {
  const lab = await basePrismaClient.lab.findUnique({
    where: { id: labId },
    include: { domainDict: true },
  });
  if (!lab || lab.researchFields.length === 0) return;

  // 이미 충분한 용어가 있으면 스킵 (시드 논문에서 채워진 경우)
  if (lab.domainDict.length >= 20) return;

  const existingTerms = new Set(lab.domainDict.map(d => d.wrongForm.toLowerCase()));
  const themes = (lab.researchThemes as ResearchTheme[] | null) || [];
  const allKeywords = [...new Set([
    ...lab.researchFields,
    ...themes.flatMap(t => t.keywords),
  ].filter(Boolean))].slice(0, 15); // 키워드 너무 많으면 토큰 낭비

  if (allKeywords.length === 0) return;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const { env } = await import('../config/env.js');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `다음 연구 키워드를 보고, 이 분야에서 자주 사용되는 기술 약어와 전문용어를 20개 생성하세요.
각 용어에 대해 "흔히 틀리는 소문자 표기"와 "정확한 표기"를 짝지어주세요.

연구 키워드: ${allKeywords.join(', ')}

규칙:
- 약어: 소문자 → 대문자 (예: pdms → PDMS, ecg → ECG)
- 화합물/소재: 잘못된 표기 → 정확한 표기 (예: pedot pss → PEDOT:PSS)
- 기법/장비: 소문자 → 정확한 표기 (예: ftir → FT-IR)
- 해당 분야에 실제로 사용되는 용어만 생성하세요
- 이미 등록된 용어는 제외: ${[...existingTerms].slice(0, 30).join(', ')}

JSON 배열로만 응답:
[{"wrong": "소문자표기", "correct": "정확한표기", "category": "분류"}]`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    });

    const text = result.response.text().trim();
    let terms: Array<{ wrong: string; correct: string; category: string }>;
    try {
      terms = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return;
      terms = JSON.parse(match[0]);
    }
    let added = 0;

    for (const t of terms) {
      if (!t.wrong || !t.correct) continue;
      if (existingTerms.has(t.wrong.toLowerCase())) continue;

      await basePrismaClient.domainDict.upsert({
        where: { labId_wrongForm: { labId, wrongForm: t.wrong.toLowerCase() } },
        create: {
          labId,
          wrongForm: t.wrong.toLowerCase(),
          correctForm: t.correct,
          category: t.category || '자동생성',
        },
        update: {},
      }).catch(() => {});
      added++;
    }

    if (added > 0) {
      console.log(`📖 DomainDict auto-generated: ${added} terms for lab ${labId}`);
    }
  } catch (err) {
    console.warn('DomainDict auto-generation failed:', err);
  }
}

/**
 * 전체 동기화 (온보딩 완료 또는 프로필 변경 시 호출)
 */
export async function syncLabProfileToAllFeatures(userId: string, labId: string) {
  await Promise.all([
    syncLabToEmailProfile(userId, labId),
    syncLabToPaperAlerts(labId),
    syncLabToDomainDict(labId),
  ]);
}
