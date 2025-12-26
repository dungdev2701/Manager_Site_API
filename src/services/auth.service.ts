import { FastifyInstance } from 'fastify';
import { UserRepository } from '../repositories/user.repository';
import { PasswordHelper } from '../utils/password';
import { UserWithoutPassword } from '../types';
import { config } from '../config/env';

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: UserWithoutPassword;
  accessToken: string;
  refreshToken: string;
}

export interface TokenPayload {
  id: string;
  email: string;
  role: string;
}

export class AuthService {
  private userRepository: UserRepository;

  constructor(private fastify: FastifyInstance) {
    this.userRepository = new UserRepository(fastify.prisma);
  }

  /**
   * Generate access token and refresh token
   */
  private generateTokens(payload: TokenPayload): { accessToken: string; refreshToken: string } {
    // Access token - short lived (từ config, mặc định 7d)
    const accessToken = this.fastify.jwt.sign(payload);

    // Refresh token - longer lived (từ config, mặc định 30d)
    const refreshToken = this.fastify.jwt.sign(payload, {
      expiresIn: config.jwt.refreshExpiresIn,
    });

    return { accessToken, refreshToken };
  }

  /**
   * Register new user
   */
  async register(input: RegisterInput): Promise<AuthResponse> {
    // Check if email already exists
    const existingUser = await this.userRepository.findByEmail(input.email);
    if (existingUser) {
      throw this.fastify.httpErrors.conflict('Email already exists');
    }

    // Validate password strength
    const passwordValidation = PasswordHelper.validateStrength(input.password);
    if (!passwordValidation.isValid) {
      throw this.fastify.httpErrors.badRequest(
        passwordValidation.errors.join(', ')
      );
    }

    // Hash password
    const hashedPassword = await PasswordHelper.hash(input.password);

    // Create user
    const user = await this.userRepository.create({
      email: input.email,
      name: input.name,
      password: hashedPassword,
      // role: CHECKER (default in schema)
      // isActive: true (default in schema)
    });

    // Generate tokens
    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    // Return user without password
    const { password, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
    };
  }

  /**
   * Login user
   */
  async login(input: LoginInput): Promise<AuthResponse> {
    // Find user by email
    const user = await this.userRepository.findByEmail(input.email);
    if (!user) {
      throw this.fastify.httpErrors.unauthorized('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await PasswordHelper.compare(
      input.password,
      user.password
    );
    if (!isPasswordValid) {
      throw this.fastify.httpErrors.unauthorized('Invalid credentials');
    }

    // Check if user is active
    if (!user.isActive) {
      throw this.fastify.httpErrors.forbidden('Account is not active');
    }

    // Generate tokens
    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    // Return user without password
    const { password, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
    };
  }

  /**
   * Get current user profile
   */
  async getProfile(userId: string): Promise<UserWithoutPassword | null> {
    return this.userRepository.findByIdSafe(userId);
  }

  /**
   * Update user profile
   */
  async updateProfile(
    userId: string,
    data: { name?: string }
  ): Promise<UserWithoutPassword> {
    const user = await this.userRepository.update(userId, data);
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Change password
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    // Get user
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw this.fastify.httpErrors.notFound('User not found');
    }

    // Verify old password
    const isPasswordValid = await PasswordHelper.compare(
      oldPassword,
      user.password
    );
    if (!isPasswordValid) {
      throw this.fastify.httpErrors.badRequest('Invalid old password');
    }

    // Validate new password strength
    const passwordValidation = PasswordHelper.validateStrength(newPassword);
    if (!passwordValidation.isValid) {
      throw this.fastify.httpErrors.badRequest(
        passwordValidation.errors.join(', ')
      );
    }

    // Hash new password
    const hashedPassword = await PasswordHelper.hash(newPassword);

    // Update password
    await this.userRepository.update(userId, {
      password: hashedPassword,
    });
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshTokenInput: string): Promise<AuthResponse> {
    try {
      // Verify refresh token
      const decoded = this.fastify.jwt.verify<TokenPayload>(refreshTokenInput);

      // Get user from database to ensure they still exist and are active
      const user = await this.userRepository.findById(decoded.id);
      if (!user) {
        throw this.fastify.httpErrors.unauthorized('User not found');
      }

      if (!user.isActive) {
        throw this.fastify.httpErrors.forbidden('Account is not active');
      }

      // Generate new tokens
      const { accessToken, refreshToken } = this.generateTokens({
        id: user.id,
        email: user.email,
        role: user.role,
      });

      // Return user without password
      const { password, ...userWithoutPassword } = user;

      return {
        user: userWithoutPassword,
        accessToken,
        refreshToken,
      };
    } catch (error) {
      // Token expired or invalid
      throw this.fastify.httpErrors.unauthorized('Invalid or expired refresh token');
    }
  }
}
