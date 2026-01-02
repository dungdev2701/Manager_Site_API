import { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import { UserRepository } from '../repositories/user.repository';
import { PasswordHelper } from '../utils/password';
import { UserWithoutPassword } from '../types';

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role?: Role;
  isActive?: boolean;
}

export interface UpdateUserInput {
  email?: string;
  name?: string;
  role?: Role;
  isActive?: boolean;
}

export interface UserQueryInput {
  page?: number;
  limit?: number;
  search?: string;
  role?: Role;
  isActive?: boolean;
}

export class UserService {
  private userRepository: UserRepository;

  constructor(private fastify: FastifyInstance) {
    this.userRepository = new UserRepository(fastify.prisma);
  }

  /**
   * Create new user (Admin only)
   */
  async createUser(input: CreateUserInput): Promise<UserWithoutPassword> {
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
      role: input.role || Role.CHECKER,
      isActive: input.isActive ?? true,
    });

    // Return user without password
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Get all users with pagination and filtering
   */
  async getAllUsers(query: UserQueryInput): Promise<{
    data: UserWithoutPassword[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: {
      OR?: { name?: { contains: string; mode: 'insensitive' }; email?: { contains: string; mode: 'insensitive' } }[];
      role?: Role;
      isActive?: boolean;
    } = {};

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.role) {
      where.role = query.role;
    }

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    // Get users and count
    const [users, total] = await Promise.all([
      this.userRepository.findAll({
        skip,
        take: limit,
        where,
        orderBy: { createdAt: 'desc' },
      }),
      this.userRepository.count(where),
    ]);

    return {
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get user by ID
   */
  async getUserById(id: string): Promise<UserWithoutPassword | null> {
    return this.userRepository.findByIdSafe(id);
  }

  /**
   * Update user (Admin only)
   */
  async updateUser(id: string, input: UpdateUserInput): Promise<UserWithoutPassword> {
    // Check if user exists
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw this.fastify.httpErrors.notFound('User not found');
    }

    // Check if email is being changed and already exists
    if (input.email && input.email !== existingUser.email) {
      const emailExists = await this.userRepository.findByEmail(input.email);
      if (emailExists) {
        throw this.fastify.httpErrors.conflict('Email already exists');
      }
    }

    // Update user
    const user = await this.userRepository.update(id, input);
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Reset user password (Admin only)
   */
  async resetPassword(id: string, newPassword: string): Promise<void> {
    // Check if user exists
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw this.fastify.httpErrors.notFound('User not found');
    }

    // Validate password strength
    const passwordValidation = PasswordHelper.validateStrength(newPassword);
    if (!passwordValidation.isValid) {
      throw this.fastify.httpErrors.badRequest(
        passwordValidation.errors.join(', ')
      );
    }

    // Hash password
    const hashedPassword = await PasswordHelper.hash(newPassword);

    // Update password
    await this.userRepository.update(id, { password: hashedPassword });
  }

  /**
   * Delete user (Admin only)
   */
  async deleteUser(id: string): Promise<void> {
    // Check if user exists
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw this.fastify.httpErrors.notFound('User not found');
    }

    // Soft delete - deactivate user
    await this.userRepository.deactivate(id);
  }

  /**
   * Permanently delete user (Admin only)
   */
  async permanentDeleteUser(id: string): Promise<void> {
    // Check if user exists
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw this.fastify.httpErrors.notFound('User not found');
    }

    await this.userRepository.delete(id);
  }

  /**
   * Activate user (Admin only)
   */
  async activateUser(id: string): Promise<UserWithoutPassword> {
    const user = await this.userRepository.activate(id);
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Deactivate user (Admin only)
   */
  async deactivateUser(id: string): Promise<UserWithoutPassword> {
    const user = await this.userRepository.deactivate(id);
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }
}
