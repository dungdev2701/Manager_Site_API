import { z } from 'zod';

/**
 * Common validation schemas dùng chung trong app
 */

// UUID validation
export const uuidSchema = z.string().uuid('Invalid ID format');

// Email validation
export const emailSchema = z.string().email('Invalid email address');

// Password validation - ít nhất 8 ký tự, có chữ hoa, chữ thường, số, ký tự đặc biệt
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/\d/, 'Password must contain at least one number')
  .regex(/[@$!%*?&]/, 'Password must contain at least one special character');

// Pagination validation
export const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .pipe(z.number().min(1, 'Page must be at least 1')),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .pipe(z.number().min(1).max(100, 'Limit must be between 1 and 100')),
});

// Sort validation
export const sortSchema = z.object({
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
});

// Search validation
export const searchSchema = z.object({
  search: z.string().optional(),
});

// Query params (pagination + sort + search)
export const queryParamsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema);
