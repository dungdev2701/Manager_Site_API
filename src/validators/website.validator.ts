import { z } from 'zod';

/**
 * Enum cho loại website
 */
export const websiteTypeEnum = z.enum(['ENTITY', 'BLOG2', 'PODCAST', 'SOCIAL', 'GG_STACKING']);

/**
 * Schema cho metrics của website
 */
export const websiteMetricsSchema = z.object({
  traffic: z.number().min(0).optional(),
  DA: z.number().min(0).max(100).optional(),
  // Captcha info
  captcha_type: z.enum(['captcha', 'normal']).optional(),
  captcha_provider: z.enum(['recaptcha', 'hcaptcha']).optional(), // Only when captcha_type = 'captcha'
  cloudflare: z.boolean().optional(), // Only when captcha_type = 'normal'
  // Index
  index: z.enum(['yes', 'no']).optional(),
  // About
  about: z.enum(['no_stacking', 'stacking_post', 'stacking_about', 'long_about']).optional(),
  about_max_chars: z.number().min(0).optional(), // Max characters allowed for about
  // Other fields
  username: z.enum(['unique', 'duplicate', 'no']).optional(), // Unique: không trùng, Duplicate: được trùng, No: không có username
  email: z.enum(['multi', 'no_multi']).optional(),
  required_gmail: z.enum(['yes', 'no']).optional(),
  verify: z.enum(['yes', 'no']).optional(),
  text_link: z.enum(['no', 'href', 'markdown', 'BBCode']).optional(),
  social_connect: z.array(z.enum(['facebook', 'twitter', 'youtube', 'linkedin'])).optional(),
  avatar: z.enum(['yes', 'no']).optional(),
  cover: z.enum(['yes', 'no']).optional(),
}).optional();

/**
 * Schema cho việc tạo 1 website
 * Chỉ nhận domain (abc.com) hoặc URL (sẽ tự extract domain)
 */
export const createWebsiteSchema = z.object({
  domain: z
    .string()
    .min(1, 'Domain is required')
    .refine(
      (input) => {
        try {
          // Thêm protocol nếu thiếu để validate
          let testUrl = input;
          if (!testUrl.match(/^https?:\/\//i)) {
            testUrl = 'http://' + testUrl;
          }
          new URL(testUrl);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid domain format. Examples: abc.com, blog.shinobi.jp, https://example.com' }
    ),
  types: z.array(websiteTypeEnum).optional(), // Default [ENTITY] in database
  notes: z.string().max(5000).optional(),
  metrics: websiteMetricsSchema,
});

/**
 * Schema cho 1 website trong bulk import (với metrics đầy đủ)
 */
export const bulkWebsiteItemSchema = z.object({
  domain: z.string().min(1),
  types: z.array(websiteTypeEnum).optional(), // Default [ENTITY] in database
  metrics: websiteMetricsSchema,
  status: z
    .enum(['NEW', 'CHECKING', 'HANDING', 'PENDING', 'RUNNING', 'ERROR', 'MAINTENANCE'])
    .optional(),
});

/**
 * Schema cho việc tạo nhiều websites
 */
export const createBulkWebsitesSchema = z.object({
  domains: z
    .array(z.string().min(1))
    .min(1, 'At least one domain is required')
    .max(1000, 'Maximum 1000 domains allowed'),
  types: z.array(websiteTypeEnum).optional(), // Default [ENTITY] in service
});

/**
 * Schema cho việc tạo nhiều websites với metrics đầy đủ
 */
export const createBulkWebsitesWithMetricsSchema = z.object({
  websites: z
    .array(bulkWebsiteItemSchema)
    .min(1, 'At least one website is required')
    .max(1000, 'Maximum 1000 websites allowed'),
});

/**
 * Schema cho việc update website
 */
export const updateWebsiteSchema = z.object({
  types: z.array(websiteTypeEnum).optional(),
  status: z
    .enum(['NEW', 'CHECKING', 'HANDING', 'PENDING', 'RUNNING', 'ERROR', 'MAINTENANCE'])
    .optional(),
  notes: z.string().max(5000).optional(),
  metrics: websiteMetricsSchema,
});

/**
 * Schema cho query parameters (pagination, filter, sort)
 */
export const websiteQuerySchema = z.object({
  page: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default('1'),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default('10'),
  type: websiteTypeEnum.optional(), // Filter by type
  status: z
    .enum(['NEW', 'CHECKING', 'HANDING', 'PENDING', 'RUNNING', 'ERROR', 'MAINTENANCE'])
    .optional(),
  search: z.string().optional(), // Tìm kiếm theo domain
  // Sort options
  sortBy: z.enum(['traffic', 'DA', 'createdAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  // Filter by metrics
  index: z.enum(['yes', 'no']).optional(),
  captcha_type: z.enum(['captcha', 'normal']).optional(),
  captcha_provider: z.enum(['recaptcha', 'hcaptcha']).optional(),
  required_gmail: z.enum(['yes', 'no']).optional(),
  verify: z.enum(['yes', 'no']).optional(),
  // Filter by date range
  startDate: z.string().optional(), // Format: YYYY-MM-DD
  endDate: z.string().optional(), // Format: YYYY-MM-DD
});

// Export types
export type WebsiteTypeDTO = z.infer<typeof websiteTypeEnum>;
export type WebsiteMetricsDTO = z.infer<typeof websiteMetricsSchema>;
export type CreateWebsiteDTO = z.infer<typeof createWebsiteSchema>;
export type CreateBulkWebsitesDTO = z.infer<typeof createBulkWebsitesSchema>;
export type BulkWebsiteItemDTO = z.infer<typeof bulkWebsiteItemSchema>;
export type CreateBulkWebsitesWithMetricsDTO = z.infer<typeof createBulkWebsitesWithMetricsSchema>;
export type UpdateWebsiteDTO = z.infer<typeof updateWebsiteSchema>;
export type WebsiteQueryDTO = z.infer<typeof websiteQuerySchema>;
