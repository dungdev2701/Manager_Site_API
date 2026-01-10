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

// Health check interval (5 phút)
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

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
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Health check để giữ connection alive và phát hiện connection drops sớm
  let healthCheckInterval: NodeJS.Timeout | null = null;

  const runHealthCheck = async () => {
    try {
      // Query đơn giản để kiểm tra connection
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      fastify.log.warn('PostgreSQL health check failed, attempting reconnect...');
      try {
        await prisma.$disconnect();
        await prisma.$connect();
        fastify.log.info('✅ PostgreSQL reconnected successfully');
      } catch (reconnectError) {
        fastify.log.error({ err: reconnectError }, 'PostgreSQL reconnect failed');
      }
    }
  };

  // Thêm prisma vào fastify instance
  fastify.decorate('prisma', prisma);

  // Start health check khi server ready
  fastify.addHook('onReady', async () => {
    healthCheckInterval = setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL);
    fastify.log.info(`PostgreSQL health check started (interval: ${HEALTH_CHECK_INTERVAL / 1000}s)`);
  });

  // Đóng kết nối khi app shutdown
  fastify.addHook('onClose', async (instance) => {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
    }
    await instance.prisma.$disconnect();
    instance.log.info('PostgreSQL connection closed');
  });
};

// Export plugin
export default fp(prismaPlugin, {
    name: 'prisma',
});
