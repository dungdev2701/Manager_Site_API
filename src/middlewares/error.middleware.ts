import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ResponseHelper } from '../utils/response';
import { ERROR_CODES, HTTP_STATUS } from '../config/constants';

/**
 * Global error handler middleware
 */
export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Log error để debug
  request.log.error(error);

  // 1. Zod validation errors
  if (error instanceof ZodError) {
    const errors = error.errors.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    }));

    return ResponseHelper.validationError(reply, errors);
  }

  // 2. Prisma database errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return handlePrismaError(error, reply);
  }

  // 3. JWT authentication errors
  if (error.message && error.message.includes('jwt')) {
    return ResponseHelper.unauthorized(
      reply,
      'Invalid or expired token',
      ERROR_CODES.AUTH_TOKEN_INVALID
    );
  }

  // 4. Fastify validation errors
  if (error.validation) {
    const errors = error.validation.map((err) => ({
      field: err.instancePath || err.params?.missingProperty,
      message: err.message,
    }));

    return ResponseHelper.validationError(reply, errors);
  }

  // 5. Rate limit errors
  if (error.statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
    return ResponseHelper.error(
      reply,
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      'Too many requests. Please try again later.',
      HTTP_STATUS.TOO_MANY_REQUESTS
    );
  }

  // 6. Default error handler
  const statusCode = error.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const message = error.message || 'Internal server error';

  return reply.code(statusCode).send({
    success: false,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message,
    },
  });
}

/**
 * Handle Prisma-specific errors
 */
function handlePrismaError(
  error: Prisma.PrismaClientKnownRequestError,
  reply: FastifyReply
): FastifyReply {
  switch (error.code) {
    // P2002: Unique constraint violation
    case 'P2002': {
      const field = (error.meta?.target as string[])?.join(', ') || 'field';
      return ResponseHelper.conflict(
        reply,
        `${field} already exists`,
        ERROR_CODES.RESOURCE_ALREADY_EXISTS
      );
    }

    // P2025: Record not found
    case 'P2025': {
      return ResponseHelper.notFound(
        reply,
        'Resource not found',
        ERROR_CODES.RESOURCE_NOT_FOUND
      );
    }

    // P2003: Foreign key constraint violation
    case 'P2003': {
      return ResponseHelper.badRequest(
        reply,
        'Invalid reference to related resource',
        ERROR_CODES.VALIDATION_ERROR
      );
    }

    // P2014: Relation violation
    case 'P2014': {
      return ResponseHelper.badRequest(
        reply,
        'Cannot delete resource with existing relations',
        ERROR_CODES.RESOURCE_CONFLICT
      );
    }

    // Default Prisma error
    default: {
      reply.log.error(`Unhandled Prisma error code: ${error.code}`);
      return ResponseHelper.internalError(
        reply,
        'Database operation failed'
      );
    }
  }
}
