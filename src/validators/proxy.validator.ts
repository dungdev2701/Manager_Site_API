import { z } from 'zod';
import { paginationSchema, searchSchema } from './common.validator';
import { ProxyType, ProxyProtocol, ProxyStatus, ProxyServiceType } from '@prisma/client';

/**
 * Create proxy schema
 */
export const createProxySchema = z.object({
  ip: z.string().min(1, 'IP is required'),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  type: z.nativeEnum(ProxyType).optional().default(ProxyType.IPV4_STATIC),
  protocol: z.nativeEnum(ProxyProtocol).optional().default(ProxyProtocol.HTTP),
  services: z.array(z.nativeEnum(ProxyServiceType)).optional().default([]),
  note: z.string().optional().nullable(),
});

/**
 * Bulk create proxy schema
 */
export const bulkCreateProxySchema = z.object({
  proxies: z.string().min(1, 'Proxy list is required'),
  type: z.nativeEnum(ProxyType).optional().default(ProxyType.IPV4_STATIC),
  protocol: z.nativeEnum(ProxyProtocol).optional().default(ProxyProtocol.HTTP),
  services: z.array(z.nativeEnum(ProxyServiceType)).optional().default([]),
  handleTrashed: z.enum(['restore', 'replace']).optional(),
});

/**
 * Update proxy schema
 */
export const updateProxySchema = z.object({
  ip: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  type: z.nativeEnum(ProxyType).optional(),
  protocol: z.nativeEnum(ProxyProtocol).optional(),
  status: z.nativeEnum(ProxyStatus).optional(),
  services: z.array(z.nativeEnum(ProxyServiceType)).optional(),
  note: z.string().optional().nullable(),
});

/**
 * Proxy query schema
 */
export const proxyQuerySchema = paginationSchema.merge(searchSchema).merge(
  z.object({
    type: z.nativeEnum(ProxyType).optional(),
    protocol: z.nativeEnum(ProxyProtocol).optional(),
    status: z.nativeEnum(ProxyStatus).optional(),
    service: z.nativeEnum(ProxyServiceType).optional(),
    country: z.string().optional(),
    sortBy: z.enum(['ip', 'createdAt', 'status', 'type', 'responseTime', 'lastCheckedAt']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    random: z
      .string()
      .optional()
      .transform((val) => val === 'true' || val === '1'),
  })
);

/**
 * Bulk delete schema
 */
export const bulkDeleteProxySchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'At least one ID is required'),
});

// Export types
export type CreateProxyDTO = z.infer<typeof createProxySchema>;
export type BulkCreateProxyDTO = z.infer<typeof bulkCreateProxySchema>;
export type UpdateProxyDTO = z.infer<typeof updateProxySchema>;
export type ProxyQueryDTO = z.infer<typeof proxyQuerySchema>;
export type BulkDeleteProxyDTO = z.infer<typeof bulkDeleteProxySchema>;
