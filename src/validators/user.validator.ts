import { z } from 'zod';
import { emailSchema, passwordSchema, paginationSchema, searchSchema } from './common.validator';
import { Role } from '@prisma/client';

/**
 * Create user schema (Admin only)
 */
export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
  password: passwordSchema,
  role: z.nativeEnum(Role).optional().default(Role.CHECKER),
  isActive: z.boolean().optional().default(true),
});

/**
 * Update user schema (Admin only)
 */
export const updateUserSchema = z.object({
  email: emailSchema.optional(),
  name: z.string().min(1, 'Name is required').max(100, 'Name is too long').optional(),
  role: z.nativeEnum(Role).optional(),
  isActive: z.boolean().optional(),
});

/**
 * Reset password schema (Admin only)
 */
export const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/**
 * User query schema
 */
export const userQuerySchema = paginationSchema.merge(searchSchema).merge(
  z.object({
    role: z.nativeEnum(Role).optional(),
    isActive: z
      .string()
      .optional()
      .transform((val) => {
        if (val === 'true') return true;
        if (val === 'false') return false;
        return undefined;
      }),
  })
);

// Export types
export type CreateUserDTO = z.infer<typeof createUserSchema>;
export type UpdateUserDTO = z.infer<typeof updateUserSchema>;
export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>;
export type UserQueryDTO = z.infer<typeof userQuerySchema>;
