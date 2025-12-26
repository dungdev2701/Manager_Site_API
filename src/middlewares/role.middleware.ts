import { FastifyRequest, FastifyReply } from 'fastify';
import { Role } from '@prisma/client';

/**
 * Middleware kiểm tra user có role được phép không
 */
export function requireRole(...allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Check authentication
    if (!request.user) {
      throw request.server.httpErrors.unauthorized('Authentication required');
    }

    // Check role
    if (!allowedRoles.includes(request.user.role as Role)) {
      throw request.server.httpErrors.forbidden(
        `Access denied. Required roles: ${allowedRoles.join(', ')}`
      );
    }

    // Continue nếu OK
  };
}

/**
 * Các helper functions cho từng permission
 */

// View: Tất cả roles
export const canViewWebsites = requireRole(
  Role.ADMIN,
  Role.MANAGER,
  Role.CHECKER,
  Role.VIEWER
);

// Create: ADMIN, MANAGER
export const canCreateWebsites = requireRole(Role.ADMIN, Role.MANAGER);

// Update: ADMIN, MANAGER, CHECKER
export const canUpdateWebsites = requireRole(
  Role.ADMIN,
  Role.MANAGER,
  Role.CHECKER
);

// Delete: ADMIN only
export const canDeleteWebsites = requireRole(Role.ADMIN);
