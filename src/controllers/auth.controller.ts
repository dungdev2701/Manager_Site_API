import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { ResponseHelper } from '../utils/response';
import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  changePasswordSchema,
  refreshTokenSchema,
  RegisterDTO,
  LoginDTO,
  RefreshTokenDTO,
} from '../validators/auth.validator';

export class AuthController {
  /**
   * Register new user
   * POST /auth/register
   */
  static async register(
    request: FastifyRequest<{ Body: RegisterDTO }>,
    reply: FastifyReply
  ) {
    // Validate request body
    const validatedData = registerSchema.parse(request.body);

    // Register user
    const authService = new AuthService(request.server);
    const result = await authService.register(validatedData);

    return ResponseHelper.created(reply, result, 'User registered successfully');
  }

  /**
   * Login user
   * POST /auth/login
   */
  static async login(
    request: FastifyRequest<{ Body: LoginDTO }>,
    reply: FastifyReply
  ) {
    // Validate request body
    const validatedData = loginSchema.parse(request.body);

    // Login user
    const authService = new AuthService(request.server);
    const result = await authService.login(validatedData);

    return ResponseHelper.success(reply, result, 'Login successful');
  }

  /**
   * Get current user profile
   * GET /auth/me
   */
  static async getProfile(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const authService = new AuthService(request.server);
    const user = await authService.getProfile(request.user.id);

    if (!user) {
      return ResponseHelper.notFound(reply, 'User not found');
    }

    return ResponseHelper.success(reply, user);
  }

  /**
   * Update user profile
   * PUT /auth/profile
   */
  static async updateProfile(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = updateProfileSchema.parse(request.body);

    // Update profile
    const authService = new AuthService(request.server);
    const user = await authService.updateProfile(request.user.id, validatedData);

    return ResponseHelper.success(reply, user, 'Profile updated successfully');
  }

  /**
   * Change password
   * PUT /auth/change-password
   */
  static async changePassword(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = changePasswordSchema.parse(request.body);

    // Change password
    const authService = new AuthService(request.server);
    await authService.changePassword(
      request.user.id,
      validatedData.oldPassword,
      validatedData.newPassword
    );

    return ResponseHelper.success(reply, null, 'Password changed successfully');
  }

  /**
   * Refresh access token
   * POST /auth/refresh
   */
  static async refreshToken(
    request: FastifyRequest<{ Body: RefreshTokenDTO }>,
    reply: FastifyReply
  ) {
    // Validate request body
    const validatedData = refreshTokenSchema.parse(request.body);

    // Refresh token
    const authService = new AuthService(request.server);
    const result = await authService.refreshToken(validatedData.refreshToken);

    return ResponseHelper.success(reply, result, 'Token refreshed successfully');
  }
}
