import { FastifyRequest, FastifyReply } from 'fastify';
import { UserService } from '../services/user.service';
import { ResponseHelper } from '../utils/response';
import {
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  userQuerySchema,
  UserQueryDTO,
} from '../validators/user.validator';

export class UserController {
  /**
   * Get all users
   * GET /users
   * Permission: ADMIN only
   */
  static async findAll(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate query params
    const query: UserQueryDTO = userQuerySchema.parse(request.query);

    // Get users
    const userService = new UserService(request.server);
    const result = await userService.getAllUsers({
      page: query.page,
      limit: query.limit,
      search: query.search,
      role: query.role,
      isActive: query.isActive,
    });

    return ResponseHelper.success(reply, result);
  }

  /**
   * Get user by ID
   * GET /users/:id
   * Permission: ADMIN only
   */
  static async findOne(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const userService = new UserService(request.server);
    const user = await userService.getUserById(id);

    if (!user) {
      return ResponseHelper.notFound(reply, 'User not found');
    }

    return ResponseHelper.success(reply, user);
  }

  /**
   * Create new user
   * POST /users
   * Permission: ADMIN only
   */
  static async create(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = createUserSchema.parse(request.body);

    // Create user
    const userService = new UserService(request.server);
    const user = await userService.createUser(validatedData);

    return ResponseHelper.created(reply, user, 'User created successfully');
  }

  /**
   * Update user
   * PUT /users/:id
   * Permission: ADMIN only
   */
  static async update(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Validate request body
    const validatedData = updateUserSchema.parse(request.body);

    // Update user
    const userService = new UserService(request.server);
    const user = await userService.updateUser(id, validatedData);

    return ResponseHelper.success(reply, user, 'User updated successfully');
  }

  /**
   * Reset user password
   * PUT /users/:id/reset-password
   * Permission: ADMIN only
   */
  static async resetPassword(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Validate request body
    const validatedData = resetPasswordSchema.parse(request.body);

    // Reset password
    const userService = new UserService(request.server);
    await userService.resetPassword(id, validatedData.newPassword);

    return ResponseHelper.success(reply, null, 'Password reset successfully');
  }

  /**
   * Delete user (soft delete - deactivate)
   * DELETE /users/:id
   * Permission: ADMIN only
   */
  static async delete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Check if trying to delete self
    if (id === request.user.id) {
      return ResponseHelper.badRequest(reply, 'Cannot delete your own account');
    }

    const userService = new UserService(request.server);
    await userService.deleteUser(id);

    return ResponseHelper.success(reply, null, 'User deactivated successfully');
  }

  /**
   * Permanently delete user
   * DELETE /users/:id/permanent
   * Permission: ADMIN only
   */
  static async permanentDelete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Check if trying to delete self
    if (id === request.user.id) {
      return ResponseHelper.badRequest(reply, 'Cannot delete your own account');
    }

    const userService = new UserService(request.server);
    await userService.permanentDeleteUser(id);

    return ResponseHelper.success(reply, null, 'User permanently deleted');
  }

  /**
   * Activate user
   * POST /users/:id/activate
   * Permission: ADMIN only
   */
  static async activate(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const userService = new UserService(request.server);
    const user = await userService.activateUser(id);

    return ResponseHelper.success(reply, user, 'User activated successfully');
  }

  /**
   * Deactivate user
   * POST /users/:id/deactivate
   * Permission: ADMIN only
   */
  static async deactivate(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Check if trying to deactivate self
    if (id === request.user.id) {
      return ResponseHelper.badRequest(reply, 'Cannot deactivate your own account');
    }

    const userService = new UserService(request.server);
    const user = await userService.deactivateUser(id);

    return ResponseHelper.success(reply, user, 'User deactivated successfully');
  }
}
