import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config/env';

const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(rateLimit, {
    max: config.rateLimit.max, // 100 requests
    timeWindow: config.rateLimit.timeWindow, // 15 minutes
    // Chỉ áp dụng global rate limit, các route cụ thể sẽ override
    global: false,
    // Custom error message
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. You can make ${context.max} requests per ${context.after}. Please try again later.`,
      retryAfter: context.after,
    }),
    // Key generator - sử dụng IP hoặc user ID nếu đã đăng nhập
    keyGenerator: (request) => {
      // Nếu user đã đăng nhập, dùng user ID
      const user = (request as any).user;
      if (user?.id) {
        return `user:${user.id}`;
      }
      // Fallback to IP
      return request.ip;
    },
  });

  fastify.log.info('Rate limiting plugin registered');
};

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
});
