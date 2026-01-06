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

// View: Tất cả roles (CTV chỉ xem website của chính họ - filter trong service)
export const canViewWebsites = requireRole(
  Role.ADMIN,
  Role.MANAGER,
  Role.DEV,
  Role.CTV,
  Role.CHECKER
);

// Create: ADMIN, MANAGER, CTV
export const canCreateWebsites = requireRole(Role.ADMIN, Role.MANAGER, Role.CTV);

// Update: ADMIN, MANAGER, DEV, CHECKER, CTV (CTV chỉ được update website của chính họ - check trong controller)
export const canUpdateWebsites = requireRole(
  Role.ADMIN,
  Role.MANAGER,
  Role.DEV,
  Role.CHECKER,
  Role.CTV
);

// Delete: ADMIN only
export const canDeleteWebsites = requireRole(Role.ADMIN);
