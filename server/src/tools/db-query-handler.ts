/**
 * DB Query Handler — Single-hop DB 쿼리, Multi-hop 체이닝, Fallback 검색
 */

import { prisma } from '../config/prisma.js';
import { calculateConfidence, getStaleWarning, trackAccess } from '../services/metamemory.js';
import type { Intent } from '../prompts/intent-classifier.js';

// ══════════════════════════════════════════════════════
//  MULTI-HOP QUERY CHAINING ENGINE
// ══════════════════════════════════════════════════════

interface HopResult {
  step: number;
  source: string;
  found: boolean;
  data: any[];
  summary: string;
}

export async function executeMultiHopQuery(
  message: string,
  entities: Record<string, string>,
  hops: Array<{ step: number; source: string; lookup: string; extract: string }>,
  labId: string,
): Promise<string> {
  const [members, projects, publications, memos] = await Promise.all([
    prisma.labMember.findMany({ where: { labId, active: true } }),
    prisma.project.findMany({ where: { labId } }),
    prisma.publication.findMany({ where: { labId } }),
    prisma.memo.findMany({ where: { labId }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  const lab = await prisma.lab.findUnique({ where: { id: labId } });

  const fuzzy = (text: string, keyword: string) =>
    text.toLowerCase().includes(keyword.toLowerCase());

  const chainResults: HopResult[] = [];
  const queryLower = message.toLowerCase();

  // ── 1단계: 메시지에서 참조되는 모든 엔티티 식별 ──
  const mentionedMembers = members.filter(m => fuzzy(message, m.name));
  const mentionedProjects = projects.filter(p =>
    fuzzy(message, p.name) ||
    (p.funder && fuzzy(message, p.funder)) ||
    (p.number && fuzzy(message, p.number))
  );
  const mentionedPubs = publications.filter(p =>
    fuzzy(message, p.title) ||
    (p.journal && fuzzy(message, p.journal))
  );

  // 패턴 A: 구성원 → 과제
  if (mentionedMembers.length > 0 && (queryLower.includes('과제') || queryLower.includes('프로젝트'))) {
    for (const member of mentionedMembers) {
      const relatedProjects = projects.filter(p =>
        p.pm?.includes(member.name) ||
        p.pm?.includes(member.name.slice(1))
      );
      chainResults.push({
        step: 1, source: 'member→project', found: relatedProjects.length > 0,
        data: relatedProjects,
        summary: relatedProjects.length > 0
          ? `${member.name}님이 담당(PM)인 과제:\n` +
            relatedProjects.map(p => `${p.name}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}`).join('\n\n')
          : `${member.name}님이 PM으로 등록된 과제가 없습니다.`,
      });
    }
  }

  // 패턴 B: 과제 → 구성원/PM
  if (mentionedProjects.length > 0 && (queryLower.includes('담당') || queryLower.includes('학생') || queryLower.includes('PM') || queryLower.includes('이메일') || queryLower.includes('연락처'))) {
    for (const proj of mentionedProjects) {
      const pmNames = (proj.pm || '').split(/[/,]/).map(s => s.trim()).filter(Boolean);
      const pmMembers = pmNames.flatMap(name =>
        members.filter(m => m.name.includes(name) || name.includes(m.name.slice(1)))
      );
      chainResults.push({
        step: 1, source: 'project→member', found: pmMembers.length > 0,
        data: pmMembers,
        summary: pmMembers.length > 0
          ? `**${proj.name}** 담당자:\n` +
            pmMembers.map(m => `${m.name} (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`).join('\n\n')
          : `**${proj.name}**의 PM: ${proj.pm || '미등록'}\n(구성원 DB에서 상세 정보를 찾지 못했습니다)`,
      });
    }
  }

  // 패턴 C: 논문 → 저자/구성원
  if (mentionedPubs.length > 0 && (queryLower.includes('저자') || queryLower.includes('교신') || queryLower.includes('누구') || queryLower.includes('이메일') || queryLower.includes('연락처'))) {
    for (const pub of mentionedPubs) {
      const authorNames = (pub.authors || '').split(/[,&]/).map(s => s.trim()).filter(Boolean);
      const authorMembers = authorNames.flatMap(name =>
        members.filter(m => name.includes(m.name) || m.name.includes(name))
      );
      chainResults.push({
        step: 1, source: 'publication→member', found: true,
        data: authorMembers,
        summary: `**${pub.title}**\n저널: ${pub.journal || '미등록'} (${pub.year || ''})\n저자: ${pub.authors || '미등록'}\n` +
          (authorMembers.length > 0
            ? '\n연구실 소속 저자:\n' + authorMembers.map(m =>
                `${m.name} (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`
              ).join('\n')
            : ''),
      });
    }
  }

  // 패턴 D: 키워드 → 과제 → PM → 연락처
  if (chainResults.length === 0 && (queryLower.includes('담당') || queryLower.includes('연락') || queryLower.includes('이메일'))) {
    const keyword = entities.query || entities.lookup || message.replace(/[의의에서로를]/g, ' ').trim();
    const matchedProjects = projects.filter(p =>
      fuzzy(p.name, keyword) || (p.funder && fuzzy(p.funder, keyword))
    );

    if (matchedProjects.length > 0) {
      const allPmNames = matchedProjects.flatMap(p =>
        (p.pm || '').split(/[/,]/).map(s => s.trim()).filter(Boolean)
      );
      const uniquePmMembers = [...new Set(allPmNames)].flatMap(name =>
        members.filter(m => m.name.includes(name) || name.includes(m.name.slice(1)))
      );

      chainResults.push({
        step: 1, source: 'keyword→project→member', found: uniquePmMembers.length > 0,
        data: uniquePmMembers,
        summary: matchedProjects.map(p =>
          `**${p.name}**\n  PM: ${p.pm || '미등록'}`
        ).join('\n') + '\n\n' +
          (uniquePmMembers.length > 0
            ? '담당자 연락처:\n' + uniquePmMembers.map(m =>
                `${m.name} (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`
              ).join('\n')
            : ''),
      });
    }
  }

  // 패턴 E: 사사 문구 질의
  if (queryLower.includes('사사') || queryLower.includes('acknowledgment')) {
    const projsWithAck = projects.filter(p => p.acknowledgment);
    if (projsWithAck.length > 0) {
      chainResults.push({
        step: 1, source: 'project.acknowledgment', found: true,
        data: projsWithAck,
        summary: projsWithAck.map(p =>
          `**${p.name}**\n사사 문구: ${p.acknowledgment}`
        ).join('\n\n'),
      });
    } else {
      const labAck = lab?.acknowledgment;
      if (labAck) {
        chainResults.push({
          step: 1, source: 'lab.acknowledgment', found: true,
          data: [{ acknowledgment: labAck }],
          summary: `연구실 기본 사사 문구:\n"${labAck}"\n\n개별 과제 사사 문구는 아직 등록되지 않았습니다. 과제별 사사 문구를 등록하시겠어요?`,
        });
      } else {
        return '등록된 사사 문구가 없습니다. 연구실 기본 사사 문구나 개별 과제 사사 문구를 등록하시겠어요?\n\n예시: "NRF 과제 사사 문구는 This work was supported by..."라고 알려주시면 저장해 드립니다.';
      }
    }
  }

  // 패턴 F: KnowledgeGraph 기반 관계 조회
  if (chainResults.length === 0) {
    const queryLower2 = message.toLowerCase();
    if (queryLower2.includes('참여') || queryLower2.includes('관계') || queryLower2.includes('연결')) {
      const userId = (await prisma.lab.findUnique({ where: { id: labId } }))?.ownerId;
      if (userId) {
        const edges = await prisma.knowledgeEdge.findMany({
          where: { relation: 'participates_in' },
          include: { fromNode: true, toNode: true },
        });
        for (const proj of mentionedProjects) {
          const projEdges = edges.filter(e => e.toNode.name === proj.name || e.toNode.entityId === proj.id);
          if (projEdges.length > 0) {
            chainResults.push({
              step: 1, source: 'knowledge_graph', found: true,
              data: projEdges,
              summary: `**${proj.name}** 참여자 (Knowledge Graph):\n` +
                projEdges.map(e => `${e.fromNode.name}`).join('\n'),
            });
          }
        }
      }
    }
  }

  if (chainResults.length > 0) {
    return chainResults.map(r => r.summary).join('\n\n---\n\n');
  }

  return await fallbackCrossSearch(message, labId, members, projects, publications, memos);
}

// ── 범용 교차 검색 ─────────────────────────────────────
async function fallbackCrossSearch(
  message: string,
  labId: string,
  members: any[],
  projects: any[],
  publications: any[],
  memos: any[],
): Promise<string> {
  const words = message.replace(/[?？을를이가에서의]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const results: string[] = [];

  for (const word of words) {
    const matchedM = members.filter(m => m.name.includes(word));
    const matchedP = projects.filter(p =>
      p.name.includes(word) || p.funder?.includes(word) || p.pm?.includes(word)
    );
    const matchedPub = publications.filter(p =>
      p.title.includes(word) || p.journal?.includes(word) || p.authors?.includes(word)
    );
    const matchedMemo = memos.filter(m => m.content.includes(word));

    if (matchedM.length) results.push(`[구성원] ${matchedM.map(m => `${m.name}(${m.role})`).join(', ')}`);
    if (matchedP.length) results.push(`[과제] ${matchedP.map(p => p.name.slice(0, 40)).join(', ')}`);
    if (matchedPub.length) results.push(`[논문] ${matchedPub.map(p => p.title.slice(0, 40)).join(', ')}`);
    if (matchedMemo.length) {
      const faqMatches = matchedMemo.filter(m => m.source === 'faq');
      const regMatches = matchedMemo.filter(m => m.source === 'regulation');
      const otherMatches = matchedMemo.filter(m => !['faq', 'regulation'].includes(m.source));
      if (faqMatches.length) results.push(`[FAQ] ${faqMatches.map(m => m.title || m.content.slice(0, 30)).join(', ')}`);
      if (regMatches.length) results.push(`[규정] ${regMatches.map(m => m.title || m.content.slice(0, 30)).join(', ')}`);
      if (otherMatches.length) results.push(`[메모] ${otherMatches.length}개 관련 메모`);
    }
  }

  if (results.length > 0) {
    return '관련 정보를 찾았습니다:\n\n' + results.join('\n');
  }

  return '';
}

// ══════════════════════════════════════════════════════
//  SINGLE-HOP DB QUERY
// ══════════════════════════════════════════════════════

export async function handleDbQuery(
  intent: Intent,
  entities: Record<string, string>,
  labId: string,
  userId: string,
  message: string,
): Promise<string | null> {
  switch (intent) {
    case 'query_project': {
      const projects = await prisma.project.findMany({ where: { labId } });
      if (projects.length === 0) return '등록된 과제가 없습니다. 과제 정보를 등록하시겠어요? "OO 과제 추가해줘"라고 말씀해 주세요.';

      const keyword = entities.projectName || entities.query || '';
      if (keyword) {
        const matched = projects.filter(p =>
          p.name.toLowerCase().includes(keyword.toLowerCase()) ||
          (p.funder && p.funder.toLowerCase().includes(keyword.toLowerCase())) ||
          (p.number && p.number.includes(keyword))
        );
        if (matched.length > 0) {
          trackAccess('project', matched.map(p => p.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
          return matched.map(p => {
            const conf = calculateConfidence(p);
            const warning = getStaleWarning(conf, p.createdAt, p.lastVerified);
            return `**${p.name}**\n  과제번호: ${p.number || '미등록'}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}\n  PM: ${p.pm || '미등록'}\n  사사문구: ${p.acknowledgment || '미등록 — 등록하시겠어요?'}` +
              (warning ? `\n  ${warning}` : '');
          }).join('\n\n');
        }
        return `"${keyword}"에 해당하는 과제를 찾지 못했습니다. 등록된 과제 ${projects.length}건 중에 해당 키워드가 없습니다.`;
      }
      trackAccess('project', projects.map(p => p.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
      return `총 ${projects.length}개 과제가 등록되어 있습니다:\n\n` +
        projects.map(p => `• ${p.name} (${p.funder || '미등록'}) [${p.status}]`).join('\n');
    }

    case 'query_publication': {
      const pubs = await prisma.publication.findMany({ where: { labId }, orderBy: { year: 'desc' } });
      if (pubs.length === 0) return '등록된 논문이 없습니다. 논문 정보를 등록하시겠어요?';

      const keyword = entities.query || '';
      if (keyword) {
        const matched = pubs.filter(p =>
          p.title.toLowerCase().includes(keyword.toLowerCase()) ||
          (p.journal && p.journal.toLowerCase().includes(keyword.toLowerCase())) ||
          (p.authors && p.authors.toLowerCase().includes(keyword.toLowerCase()))
        );
        if (matched.length > 0) {
          trackAccess('publication', matched.map(p => p.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
          return matched.map(p => {
            const conf = calculateConfidence(p);
            const warning = getStaleWarning(conf, p.createdAt, p.lastVerified);
            return `**${p.title}**\n  저널: ${p.journal || '미등록'} (${p.year || ''})\n  저자: ${p.authors || '미등록'}\n  DOI: ${p.doi || '미등록'}` +
              (warning ? `\n  ${warning}` : '');
          }).join('\n\n');
        }
        return `"${keyword}"에 해당하는 논문을 찾지 못했습니다. 등록된 논문 ${pubs.length}편 중에 해당 키워드가 없습니다.`;
      }
      return `총 ${pubs.length}편의 논문이 등록되어 있습니다.\n\n` +
        pubs.slice(0, 10).map(p => `• ${p.title} (${p.journal || ''}, ${p.year || ''})`).join('\n');
    }

    case 'query_member': {
      const members = await prisma.labMember.findMany({ where: { labId, active: true } });
      if (members.length === 0) return '등록된 구성원이 없습니다. 구성원 정보를 등록하시겠어요?';

      const rawName = entities.name || entities.query || '';
      const name = rawName.replace(/\s*(학생|교수|박사|석사|연구원|인턴|포닥)$/, '').trim();
      if (name) {
        const matched = members.filter(m =>
          m.name.includes(name) || name.includes(m.name) || (m.email && m.email.includes(name))
        );
        if (matched.length > 0) {
          trackAccess('labMember', matched.map(m => m.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
          return matched.map(m => {
            const conf = calculateConfidence(m);
            const warning = getStaleWarning(conf, m.createdAt, m.lastVerified);
            return `**${m.name}** (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}` +
              (warning ? `\n  ${warning}` : '');
          }).join('\n\n');
        }
        return `"${name}"에 해당하는 구성원을 찾지 못했습니다. 등록하시겠어요? "${name} 학생 추가해줘"라고 말씀해 주세요.`;
      }
      return `총 ${members.length}명의 구성원이 등록되어 있습니다:\n\n` +
        members.map(m => `• ${m.name} (${m.role}) — ${m.email || '이메일 미등록'}`).join('\n');
    }

    case 'query_meeting': {
      const meetings = await prisma.meeting.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (meetings.length === 0) return '저장된 미팅 기록이 없습니다. 미팅을 녹음하고 정리해 보시겠어요?';
      return meetings.map(m =>
        `**${m.title}** (${m.createdAt.toLocaleDateString('ko-KR')})\n  ${m.summary?.slice(0, 200) || '요약 없음'}...`
      ).join('\n\n');
    }

    case 'query_stale': {
      const [memos, members, projects, pubs] = await Promise.all([
        prisma.memo.findMany({ where: { labId } }),
        prisma.labMember.findMany({ where: { labId, active: true } }),
        prisma.project.findMany({ where: { labId } }),
        prisma.publication.findMany({ where: { labId } }),
      ]);

      type StaleItem = { type: string; name: string; confidence: number; ageMonths: number; id: string };
      const staleItems: StaleItem[] = [];

      for (const m of memos) {
        const conf = calculateConfidence(m);
        if (conf < 0.7) {
          const ageMonths = Math.floor((Date.now() - m.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
          staleItems.push({ type: '메모', name: m.title || m.content.slice(0, 40), confidence: conf, ageMonths, id: m.id });
        }
      }
      for (const p of projects) {
        const conf = calculateConfidence(p);
        if (conf < 0.7) {
          const ageMonths = Math.floor((Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
          staleItems.push({ type: '과제', name: p.name, confidence: conf, ageMonths, id: p.id });
        }
      }
      for (const p of pubs) {
        const conf = calculateConfidence(p);
        if (conf < 0.7) {
          const ageMonths = Math.floor((Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
          staleItems.push({ type: '논문', name: p.title.slice(0, 50), confidence: conf, ageMonths, id: p.id });
        }
      }

      staleItems.sort((a, b) => a.confidence - b.confidence);

      if (staleItems.length === 0) {
        return '모든 Lab Memory 정보가 최신 상태입니다! 업데이트가 필요한 항목이 없습니다.';
      }

      return `**업데이트가 필요한 정보 (${staleItems.length}건)**\n\n` +
        staleItems.slice(0, 20).map((item, i) =>
          `${i + 1}. [${item.type}] **${item.name}**\n   신뢰도: ${(item.confidence * 100).toFixed(0)}% | ${item.ageMonths}개월 전 등록`
        ).join('\n') +
        '\n\n정보를 확인하셨다면 "OO 정보 최신 확인" 이라고 말씀해 주세요.';
    }

    case 'search_memory': {
      const keyword = entities.query || entities.keyword || message.replace(/[?？을를이가에서의로는은해줘줘요알려]/g, ' ').trim();
      const words = keyword.split(/\s+/).filter(w => w.length > 1);

      const memos = await prisma.memo.findMany({
        where: {
          userId,
          OR: words.flatMap(w => [
            { title: { contains: w, mode: 'insensitive' as const } },
            { content: { contains: w, mode: 'insensitive' as const } },
            { tags: { has: w } },
          ]),
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      if (memos.length > 0) {
        return memos.map((m, i) =>
          `${i + 1}. [${m.source || '메모'}] **${m.title || '(제목없음)'}**\n${m.content.substring(0, 300)}`
        ).join('\n\n');
      }

      const members = await prisma.labMember.findMany({ where: { labId, active: true } });
      const matchedMembers = members.filter(m => words.some(w => m.name.includes(w)));
      if (matchedMembers.length > 0) {
        return matchedMembers.map(m => `${m.name} (${m.role}) — ${m.email || ''}`).join('\n');
      }

      return null;
    }

    case 'fallback_search': {
      const words = message.replace(/[?？을를이가에서의로는은해줘줘요알려정보]/g, ' ').split(/\s+/).filter(w => w.length > 1);
      const results: string[] = [];

      const memos = await prisma.memo.findMany({
        where: {
          userId,
          OR: words.flatMap(w => [
            { title: { contains: w, mode: 'insensitive' as const } },
            { content: { contains: w, mode: 'insensitive' as const } },
          ]),
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (memos.length > 0) {
        results.push(...memos.map(m => `[${m.source || '메모'}] **${m.title}**\n${m.content.substring(0, 200)}`));
      }

      const allMembers = await prisma.labMember.findMany({ where: { labId, active: true } });
      const allProjects = await prisma.project.findMany({ where: { labId } });

      for (const word of words) {
        const matchedM = allMembers.filter(m => m.name.includes(word));
        const matchedP = allProjects.filter(p => p.name.includes(word) || p.funder?.includes(word));
        if (matchedM.length) results.push(`[구성원] ${matchedM.map(m => `${m.name}(${m.role})`).join(', ')}`);
        if (matchedP.length) results.push(`[과제] ${matchedP.map(p => p.name).join(', ')}`);
      }

      if (results.length > 0) {
        return `다음과 관련된 정보를 찾았습니다:\n\n${results.join('\n\n')}`;
      }
      return null;
    }

    default:
      return null;
  }
}
