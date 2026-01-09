import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env';

/**
 * Middleware để validate API Key từ header hoặc query parameter
 *
 * Usage:
 * - Header: x-api-key: <API_KEY>
 * - Query: ?apikey=<API_KEY>
 */
export async function apiKeyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Get API key from header or query
  const apiKeyFromHeader = request.headers['x-api-key'] as string | undefined;
  const apiKeyFromQuery = (request.query as { apikey?: string }).apikey;

  const apiKey = apiKeyFromHeader || apiKeyFromQuery;

  if (!apiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'API key is required. Provide via x-api-key header or apikey query parameter.',
    });
  }

  if (apiKey !== config.publicApiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  // API key is valid, continue
}
