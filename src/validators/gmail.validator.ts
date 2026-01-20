import { z } from 'zod';
import { emailSchema, paginationSchema, searchSchema } from './common.validator';
import { GmailStatus } from '@prisma/client';

/**
 * Create gmail schema
 */
export const createGmailSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  appPassword: z.string().optional(),
  twoFA: z.string().optional(),
  recoveryEmail: emailSchema.optional().or(z.literal('')),
  ownerId: z.string().uuid().optional().nullable(),
  status: z.nativeEnum(GmailStatus).optional().default(GmailStatus.SUCCESS),
});

/**
 * Update gmail schema
 */
export const updateGmailSchema = z.object({
  email: emailSchema.optional(),
  password: z.string().min(1, 'Password is required').optional(),
  appPassword: z.string().optional().nullable(),
  twoFA: z.string().optional().nullable(),
  recoveryEmail: emailSchema.optional().nullable().or(z.literal('')),
  ownerId: z.string().uuid().optional().nullable(),
  status: z.nativeEnum(GmailStatus).optional(),
});

/**
 * Gmail query schema
 */
export const gmailQuerySchema = paginationSchema.merge(searchSchema).merge(
  z.object({
    status: z.nativeEnum(GmailStatus).optional(),
    ownerId: z.string().optional(), // Can be UUID or 'none' for null owner
    startDate: z.string().optional(), // ISO date string
    endDate: z.string().optional(), // ISO date string
    sortBy: z.enum(['email', 'createdAt', 'status']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  })
);

// Export types
export type CreateGmailDTO = z.infer<typeof createGmailSchema>;
export type UpdateGmailDTO = z.infer<typeof updateGmailSchema>;
export type GmailQueryDTO = z.infer<typeof gmailQuerySchema>;
