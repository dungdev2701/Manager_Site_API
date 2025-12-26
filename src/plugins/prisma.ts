import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

// Khai báo type cho fastify.prisma
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

// Singleton pattern for Prisma Client - reuse connection across hot reloads
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  // Reuse existing client or create new one with optimized settings
  const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
      log: fastify.log.level === 'debug' ? ['query', 'error', 'warn'] : ['error'],
      // Connection pool optimization
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });

  // Store in global for reuse (prevents connection exhaustion in dev)
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
  }

  // Connect with retry logic
  let retries = 3;
  while (retries > 0) {
    try {
      await prisma.$connect();
      fastify.log.info('✅ PostgreSQL connected (connection pool ready)');
      break;
    } catch (error) {
      retries--;
      if (retries === 0) throw error;
      fastify.log.warn(`PostgreSQL connection failed, retrying... (${retries} left)`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Thêm prisma vào fastify instance
  fastify.decorate('prisma', prisma);

  // Đóng kết nối khi app shutdown
  fastify.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect();
    instance.log.info('PostgreSQL connection closed');
  });
};

// Export plugin
export default fp(prismaPlugin, {
    name: 'prisma',
});
