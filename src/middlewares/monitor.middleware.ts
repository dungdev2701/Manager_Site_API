import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env';

/**
 * Middleware để validate API Key cho Monitor Service
 *
 * SECURITY:
 * - API Key PHẢI được gửi qua header x-api-key
 * - Chỉ cho phép Monitor Service truy cập các endpoint cần thiết
 *
 * Usage:
 * - Header: x-api-key: <MONITOR_API_KEY>
 */
export async function monitorApiKeyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const apiKey = request.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'API key is required. Provide via x-api-key header.',
    });
  }

  // Check if API key matches Monitor Service key
  if (!config.monitorApiKey || apiKey !== config.monitorApiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  // API key hợp lệ, cho phép tiếp tục
  return;
}
