import { FastifyReply, FastifyRequest } from 'fastify';
import { WebsiteType } from '@prisma/client';
import { config } from '../config/env';

// Map từ API key -> WebsiteType được phép truy cập
type ApiKeyTypeMap = {
  [key: string]: WebsiteType;
};

/**
 * Tạo map từ API key -> WebsiteType
 * Chỉ include các keys đã được configure trong .env
 */
function buildApiKeyMap(): ApiKeyTypeMap {
  const map: ApiKeyTypeMap = {};

  if (config.apiKeys.ENTITY) {
    map[config.apiKeys.ENTITY] = WebsiteType.ENTITY;
  }
  if (config.apiKeys.BLOG2) {
    map[config.apiKeys.BLOG2] = WebsiteType.BLOG2;
  }
  if (config.apiKeys.PODCAST) {
    map[config.apiKeys.PODCAST] = WebsiteType.PODCAST;
  }
  if (config.apiKeys.SOCIAL) {
    map[config.apiKeys.SOCIAL] = WebsiteType.SOCIAL;
  }
  if (config.apiKeys.GG_STACKING) {
    map[config.apiKeys.GG_STACKING] = WebsiteType.GG_STACKING;
  }

  return map;
}

// Build map một lần khi server start
const apiKeyMap = buildApiKeyMap();

// Extend FastifyRequest để lưu allowedType và isRestrictedKey
declare module 'fastify' {
  interface FastifyRequest {
    allowedType?: WebsiteType;
    isRestrictedKey?: boolean; // true nếu dùng API key mới (chỉ được truy cập RUNNING)
  }
}

/**
 * Middleware để validate API Key từ header
 *
 * SECURITY:
 * - API Key PHẢI được gửi qua header x-api-key (KHÔNG qua URL query)
 * - Mỗi API key chỉ được phép truy cập 1 type cụ thể
 * - Chỉ được truy cập websites có status=RUNNING
 *
 * Usage:
 * - Header: x-api-key: <API_KEY>
 *
 * Sau khi validate:
 * - request.allowedType sẽ chứa WebsiteType mà key được phép truy cập
 */
export async function apiKeyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Chỉ chấp nhận API key từ header (bảo mật hơn, không lộ trong URL)
  const apiKey = request.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'API key is required. Provide via x-api-key header.',
    });
  }

  // Kiểm tra xem API key có trong map không
  const allowedType = apiKeyMap[apiKey];

  if (allowedType) {
    // API key hợp lệ, lưu type được phép vào request
    request.allowedType = allowedType;
    request.isRestrictedKey = true; // Chỉ được truy cập status=RUNNING
    return;
  }

  // API key không hợp lệ
  return reply.status(401).send({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Invalid API key',
  });
}
