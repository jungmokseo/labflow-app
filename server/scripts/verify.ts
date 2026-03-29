import { PrismaClient } from '@prisma/client';

export async function verify(prisma: PrismaClient) {
  console.log('\n🔍 마이그레이션 검증...');

  const users = await prisma.user.count();
  const labs = await prisma.lab.count();
  const members = await prisma.labMember.count();
  const projects = await prisma.project.count();
  const memoFaq = await prisma.memo.count({ where: { source: 'faq' } });
  const memoReg = await prisma.memo.count({ where: { source: 'regulation' } });
  const memoVac = await prisma.memo.count({ where: { source: 'vacation' } });
  const memoAcc = await prisma.memo.count({ where: { source: 'account' } });
  const totalMemos = await prisma.memo.count();
  const nullUserMemos = await prisma.memo.count({ where: { userId: '' } });
  const nodes = await prisma.knowledgeNode.count();
  const edges = await prisma.knowledgeEdge.count();

  const results = {
    'User': { count: users, pass: users >= 1 },
    'Lab': { count: labs, pass: labs >= 1 },
    'LabMember': { count: members, pass: members >= 5 },
    'Project': { count: projects, pass: projects >= 5 },
    'Memo(faq)': { count: memoFaq, pass: memoFaq >= 0 },
    'Memo(regulation)': { count: memoReg, pass: memoReg >= 0 },
    'Memo(vacation)': { count: memoVac, pass: memoVac >= 0 },
    'Memo(account)': { count: memoAcc, pass: memoAcc >= 0 },
    'Memo(total)': { count: totalMemos, pass: totalMemos > 0 },
    'Memo userId NOT NULL': { count: nullUserMemos, pass: nullUserMemos === 0 },
    'KnowledgeNode': { count: nodes, pass: nodes >= 20 },
    'KnowledgeEdge': { count: edges, pass: edges >= 10 },
  };

  let allPass = true;
  for (const [name, { count, pass }] of Object.entries(results)) {
    const icon = pass ? '✅' : '❌';
    console.log(`  ${icon} ${name}: ${count}`);
    if (!pass) allPass = false;
  }

  console.log(`\n${allPass ? '🎉 모든 검증 통과!' : '⚠️ 일부 검증 실패 — 위 항목 확인 필요'}`);
  return allPass;
}
