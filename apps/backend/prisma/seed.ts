import { PrismaClient } from '@prisma/client';
import { hashSync } from 'bcryptjs';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = 'demo@example.com';
  const password = 'demo1234';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return;
  }

  await prisma.user.create({
    data: {
      email,
      passwordHash: hashSync(password, 10)
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('Seed failed', error);
    await prisma.$disconnect();
    process.exit(1);
  });
