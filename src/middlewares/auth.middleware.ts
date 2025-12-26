import { FastifyRequest, FastifyReply } from 'fastify';
import { ResponseHelper } from '../utils/response';
import { ERROR_CODES } from '../config/constants';
import { Role } from '@prisma/client';

/**
 * Middleware to verify JWT token and attach user to request
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    // Verify JWT token
    const decoded = await request.jwtVerify<any>();

    // Get user from database
    const user = await request.server.prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return ResponseHelper.unauthorized(
        reply,
        'User not found',
        ERROR_CODES.AUTH_UNAUTHORIZED
      );
    }

    // Check if user is active
    if (!user.isActive) {
      return ResponseHelper.forbidden(
        reply,
        'Account is not active',
        ERROR_CODES.AUTH_USER_INACTIVE
      );
    }

    // Attach user to request
    request.user = user;
  } catch (err) {
    return ResponseHelper.unauthorized(
      reply,
      'Invalid or expired token',
      ERROR_CODES.AUTH_TOKEN_INVALID
    );
  }
}

/**
 * Middleware to check if user has required role
 */
export function roleMiddleware(allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return ResponseHelper.unauthorized(
        reply,
        'Authentication required',
        ERROR_CODES.AUTH_UNAUTHORIZED
      );
    }

    if (!allowedRoles.includes(request.user.role as Role)) {
      return ResponseHelper.forbidden(
        reply,
        'You do not have permission to access this resource',
        ERROR_CODES.AUTH_FORBIDDEN
      );
    }
  };
}

/**
 * Optional auth middleware - doesn't fail if no token provided
 */
export async function optionalAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const decoded = await request.jwtVerify<any>();

    const user = await request.server.prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (user && user.isActive) {
      request.user = user;
    }
  } catch (err) {
    // Ignore error, request.user will remain undefined
  }
}
