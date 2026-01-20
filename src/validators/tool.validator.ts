import { z } from 'zod';
import { paginationSchema, searchSchema } from './common.validator';
import { ToolType, ToolStatus, ToolService } from '@prisma/client';

/**
 * Create tool schema
 */
export const createToolSchema = z.object({
  idTool: z.string().min(1, 'Tool ID is required'),
  userId: z.string().uuid().optional().nullable(),
  threadNumber: z.number().int().min(1).optional().default(1),
  type: z.nativeEnum(ToolType).optional().default(ToolType.INDIVIDUAL),
  status: z.nativeEnum(ToolStatus).optional().default(ToolStatus.RUNNING),
  service: z.nativeEnum(ToolService).optional().default(ToolService.ENTITY),
  estimateTime: z.number().int().min(0).optional().nullable(),
  customerType: z.string().optional().nullable(),
});

/**
 * Update tool schema
 */
export const updateToolSchema = z.object({
  idTool: z.string().min(1, 'Tool ID is required').optional(),
  userId: z.string().uuid().optional().nullable(),
  threadNumber: z.number().int().min(1).optional(),
  type: z.nativeEnum(ToolType).optional(),
  status: z.nativeEnum(ToolStatus).optional(),
  service: z.nativeEnum(ToolService).optional(),
  estimateTime: z.number().int().min(0).optional().nullable(),
  customerType: z.string().optional().nullable(),
});

/**
 * Tool query schema
 */
export const toolQuerySchema = paginationSchema.merge(searchSchema).merge(
  z.object({
    type: z.nativeEnum(ToolType).optional(),
    status: z.nativeEnum(ToolStatus).optional(),
    service: z.nativeEnum(ToolService).optional(),
    userId: z.string().uuid().optional(),
    sortBy: z.enum(['idTool', 'createdAt', 'status', 'type', 'service']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  })
);

// Export types
export type CreateToolDTO = z.infer<typeof createToolSchema>;
export type UpdateToolDTO = z.infer<typeof updateToolSchema>;
export type ToolQueryDTO = z.infer<typeof toolQuerySchema>;
