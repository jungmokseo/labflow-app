/**
 * 추가 인사이트 작성용 DB 데이터 일괄 덤프.
 * 출력: scripts/insight-data.json (분석 용도)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  const lab = await prisma.lab.findUnique({ where: { id: LAB_ID }, select: { ownerId: true } });
  if (!lab) { console.error('lab 없음'); process.exit(1); }
  const userId = lab.ownerId;

  // 1. 전체 LabMember
  const members = await prisma.labMember.findMany({
    where: { labId: LAB_ID, active: true },
    select: { name: true, nameEn: true, role: true, email: true, team: true, metadata: true },
  });

  // 2. MemberInfo (학위/입학)
  const memberInfos = await prisma.memberInfo.findMany({
    where: { labId: LAB_ID },
    select: { name: true, degree: true, department: true, joinYear: true, graduationYear: true },
  });

  // 3. Publications
  const pubs = await prisma.publication.findMany({
    where: { labId: LAB_ID },
    select: { title: true, authors: true, journal: true, year: true, nickname: true },
    orderBy: { year: 'desc' },
  });

  // 4. Projects (모든 필드)
  const projects = await prisma.project.findMany({
    where: { labId: LAB_ID, status: 'active' },
    select: {
      name: true, shortName: true, businessName: true,
      funder: true, period: true, pi: true, pm: true,
      ministry: true, responsibility: true,
    },
  });

  // 5. Acknowledgments
  const acks = await prisma.acknowledgment.findMany({
    where: { labId: LAB_ID },
    select: { paperTitle: true, type: true, journal: true, publishedAt: true, acknowledgedProjects: true },
  });

  // 6. Knowledge graph 상위 노드 (중심성)
  const nodes = await prisma.knowledgeNode.findMany({
    where: { userId },
    select: {
      name: true, entityType: true,
      outEdges: { select: { id: true } },
      inEdges: { select: { id: true } },
    },
  });
  const topNodes = nodes
    .map(n => ({ name: n.name, type: n.entityType, degree: n.outEdges.length + n.inEdges.length }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 30);

  // 7. Wiki article 태그 분포
  const articles = await prisma.wikiArticle.findMany({
    where: { labId: LAB_ID },
    select: { category: true, tags: true },
  });
  const tagCounts: Record<string, number> = {};
  for (const a of articles) for (const t of a.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30);

  // 8. 최근 미팅 유형 분포
  const meetings = await prisma.meeting.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - 90 * 86400 * 1000) } },
    select: { title: true, summary: true, actionItems: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  const output = {
    members: { count: members.length, list: members },
    memberInfos: { count: memberInfos.length, list: memberInfos },
    publications: { count: pubs.length, list: pubs },
    projects: { count: projects.length, list: projects },
    acknowledgments: { count: acks.length, list: acks },
    knowledgeGraph: { totalNodes: nodes.length, topByCentrality: topNodes },
    tagDistribution: topTags,
    recentMeetings: { count: meetings.length, list: meetings.slice(0, 15) },
  };

  const outPath = path.join(process.cwd(), 'scripts', 'insight-data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`✓ ${outPath}`);
  console.log(`  members=${members.length}, memberInfos=${memberInfos.length}, pubs=${pubs.length}, projects=${projects.length}, acks=${acks.length}, nodes=${nodes.length}, tags=${topTags.length}, meetings=${meetings.length}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
