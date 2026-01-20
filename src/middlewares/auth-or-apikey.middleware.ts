import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env';

/**
 * Middleware cho phép xác thực bằng JWT token HOẶC PUBLIC_API_KEY
 *
 * Ưu tiên:
 * 1. Kiểm tra JWT token trong header Authorization
 * 2. Nếu không có token, kiểm tra x-api-key header với PUBLIC_API_KEY
 *
 * Usage:
 * - Header: Authorization: Bearer <token>
 * - Hoặc Header: x-api-key: <PUBLIC_API_KEY>
 */
export async function authOrApiKeyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // 1. Kiểm tra JWT token trước
  const authHeader = request.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    try {
      // Verify JWT token
      const decoded = await request.server.jwt.verify(token);
      request.user = decoded as FastifyRequest['user'];
      return; // Xác thực thành công bằng JWT
    } catch {
      // Token không hợp lệ, tiếp tục kiểm tra API key
    }
  }

  // 2. Kiểm tra PUBLIC_API_KEY
  const apiKey = request.headers['x-api-key'] as string | undefined;

  if (apiKey && apiKey === config.publicApiKey) {
    // API key hợp lệ - không cần set request.user vì đây là public API
    return;
  }

  // Không có xác thực hợp lệ
  return reply.status(401).send({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Authentication required. Provide JWT token via Authorization header or API key via x-api-key header.',
  });
}
