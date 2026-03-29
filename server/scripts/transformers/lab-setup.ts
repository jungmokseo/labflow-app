import { PrismaClient } from '@prisma/client';

export async function setupLabAndUser(prisma: PrismaClient) {
  const user = await prisma.user.upsert({
    where: { email: 'jungmok.seo@gmail.com' },
    update: {},
    create: {
      clerkId: 'dev-user-seo',
      email: 'jungmok.seo@gmail.com',
      name: '서정목',
      labName: 'BLISS Lab',
      plan: 'MAX',
      credits: 9999,
    },
  });
  console.log(`✅ User created: ${user.name} (${user.id})`);

  const lab = await prisma.lab.upsert({
    where: { ownerId: user.id },
    update: {},
    create: {
      ownerId: user.id,
      name: 'BLISS Lab',
      institution: 'Yonsei University',
      department: 'Department of Chemical and Biomolecular Engineering',
      piName: '서정목',
      piEmail: 'jungmok.seo@gmail.com',
      researchFields: ['flexible electronics', 'biosensors', 'hydrogel', 'packaging', 'wearable devices'],
      homepageUrl: 'https://blisslab.yonsei.ac.kr',
      onboardingDone: true,
    },
  });
  console.log(`✅ Lab created: ${lab.name} (${lab.id})`);

  return { user, lab };
}
