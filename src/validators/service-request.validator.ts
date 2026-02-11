import { z } from 'zod';
import { ServiceType, RequestStatus, DomainSelection } from '@prisma/client';
import { paginationSchema, searchSchema, sortSchema } from './common.validator';

// ==================== CONFIG SCHEMAS PER SERVICE TYPE ====================

// Entity config (based on EntityRequest from KH)
const entityConfigSchema = z.object({
  email: z.string().email().max(125),
  appPassword: z.string().max(55),
  username: z.string().max(55),
  entityLimit: z.number().int().min(1),
  website: z.string().max(500),
  fixedSites: z.string().optional().nullable(),
  accountType: z.enum(['multiple', 'once']).default('multiple'),
  spinContent: z.enum(['always', 'never']).default('always'),
  entityConnect: z.string(),
  socialConnect: z.string().optional().nullable().default(''),
  firstName: z.string().max(25),
  lastName: z.string().max(25),
  about: z.string(),
  address: z.string().max(200),
  phone: z.string().max(20),
  location: z.string().max(100),
  avatar: z.string().max(500).optional().nullable(),
  cover: z.string().max(500).optional().nullable(),
});

// Blog2 config (based on Blog20Request from KH)
const blog2ConfigSchema = z.object({
  blogGroupId: z.string().optional().nullable(),
  typeRequest: z.enum(['post', 'register']).default('post'),
  target: z.number().int().min(0).optional().default(0),
  data: z.string().optional().nullable(),
});

// Social content data - AI generated
const socialContentAISchema = z.object({
  contentType: z.literal('AI'),
  language: z.string().max(50),
  keyword: z.string(),
  image_link: z.string().optional().nullable(),
});

// Social content data - manual
const socialContentManualSchema = z.object({
  contentType: z.literal('manual'),
  image_link: z.string().optional().nullable(),
  title: z.string(),
  content: z.string(),
});

// Social config (based on SocialRequest from KH)
const socialConfigSchema = z.object({
  socialGroupId: z.string().optional().nullable(),
  website: z.string().max(500),
  percentage: z.number().min(0).max(100).default(100),
  unique_url: z.boolean().default(true),
  email_report: z.boolean().default(true),
  share_code: z.boolean().default(true),
  auction_price: z.number().min(0).default(0),
  data: z.discriminatedUnion('contentType', [
    socialContentAISchema,
    socialContentManualSchema,
  ]),
});

// Podcast config (based on PodcastRequest from KH)
const podcastConfigSchema = z.object({
  podcastGroupId: z.string().optional().nullable(),
  typeRequest: z.enum(['post', 'register']).default('post'),
  target: z.number().int().min(0).optional().default(0),
  data: z.string().optional().nullable(),
});

// GG Stacking config (based on GoogleStackingRequest from KH)
const ggStackingConfigSchema = z.object({
  folderUrl: z.string().optional().nullable(),
  title: z.string().max(500),
  website: z.string().max(255),
  about: z.string(),
  phone: z.string().max(20),
  address: z.string().max(200),
  location: z.string().max(100),
  stackingConnect: z.string().optional().nullable(),
  spinContent: z.enum(['always', 'never']).default('always'),
  duplicate: z.number().int().min(0).default(0),
});

// ==================== CREATE SERVICE REQUEST ====================

export const createServiceRequestSchema = z
  .object({
    // External user info (từ website KH)
    externalUserId: z.string().min(1),
    externalUserEmail: z.string().email().max(255).optional().nullable(),
    externalUserName: z.string().max(255).optional().nullable(),
    // Assign nhân viên nội bộ (optional)
    assignedUserId: z.string().uuid().optional().nullable(),
    // Service request data
    serviceType: z.nativeEnum(ServiceType),
    serviceGroupId: z.string().optional().nullable(),
    externalId: z.string().optional().nullable(),
    name: z.string().max(255).optional().nullable(),
    typeRequest: z.string().max(50).optional().nullable(),
    target: z.string().optional().nullable(),
    auctionPrice: z.number().min(0).optional().nullable(),
    domains: z.nativeEnum(DomainSelection).optional().default('LIKEPION'),
    config: z.record(z.unknown()).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    // Validate config based on serviceType
    if (data.config) {
      let result;
      switch (data.serviceType) {
        case 'ENTITY':
          result = entityConfigSchema.safeParse(data.config);
          break;
        case 'BLOG2':
          result = blog2ConfigSchema.safeParse(data.config);
          break;
        case 'SOCIAL':
          result = socialConfigSchema.safeParse(data.config);
          break;
        case 'PODCAST':
          result = podcastConfigSchema.safeParse(data.config);
          break;
        case 'GG_STACKING':
          result = ggStackingConfigSchema.safeParse(data.config);
          break;
      }
      if (result && !result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ['config', ...issue.path],
          });
        });
      }
    }
  });

// ==================== UPDATE SERVICE REQUEST ====================

export const updateServiceRequestSchema = z.object({
  name: z.string().max(255).optional().nullable(),
  typeRequest: z.string().max(50).optional().nullable(),
  target: z.string().optional().nullable(),
  auctionPrice: z.number().min(0).optional().nullable(),
  domains: z.nativeEnum(DomainSelection).optional(),
  config: z.record(z.unknown()).optional().nullable(),
  serviceGroupId: z.string().optional().nullable(),
});

// ==================== QUICK UPDATE (admin/dev only) ====================

export const quickUpdateSchema = z.object({
  idTool: z.string().optional().nullable(),
  runCount: z.number().int().min(0).optional(),
  target: z.string().optional().nullable(),
  status: z.nativeEnum(RequestStatus).optional(),
});

// ==================== UPDATE STATUS ====================

export const updateStatusSchema = z.object({
  status: z.nativeEnum(RequestStatus),
});

// ==================== FLEXIBLE FIND BY ID ====================

// Available fields for selection
const serviceRequestFields = [
  'id', 'externalUserId', 'externalUserEmail', 'externalUserName',
  'assignedUserId', 'serviceType', 'serviceGroupId', 'externalId',
  'name', 'typeRequest', 'target', 'auctionPrice', 'domains',
  'config', 'idTool', 'runCount', 'status', 'createdAt', 'updatedAt',
] as const;

// Available includes (relations)
const serviceRequestIncludes = [
  'assignedUser', 'batches', 'allocationItems',
] as const;

export const flexibleFindByIdSchema = z.object({
  // Comma-separated field names or 'all' for all fields
  fields: z.string().optional().default('all'),
  // Comma-separated include names
  include: z.string().optional(),
  // For allocationItems - filter by status
  itemStatus: z.string().optional(),
  // For allocationItems - limit number of items
  itemLimit: z.coerce.number().int().min(1).max(1000).optional(),
});

export type FlexibleFindByIdDTO = z.infer<typeof flexibleFindByIdSchema>;
export const AVAILABLE_FIELDS = serviceRequestFields;
export const AVAILABLE_INCLUDES = serviceRequestIncludes;

// ==================== QUERY ====================

export const serviceRequestQuerySchema = paginationSchema
  .merge(searchSchema)
  .merge(sortSchema)
  .merge(
    z.object({
      serviceType: z.nativeEnum(ServiceType).optional(),
      status: z.nativeEnum(RequestStatus).optional(),
      externalUserId: z.string().optional(),
      domains: z.nativeEnum(DomainSelection).optional(),
    })
  );

// ==================== EXPORT TYPES ====================

export type CreateServiceRequestDTO = z.infer<typeof createServiceRequestSchema>;
export type UpdateServiceRequestDTO = z.infer<typeof updateServiceRequestSchema>;
export type UpdateStatusDTO = z.infer<typeof updateStatusSchema>;
export type ServiceRequestQueryDTO = z.infer<typeof serviceRequestQuerySchema>;

// Export config schemas for use in service
export {
  entityConfigSchema,
  blog2ConfigSchema,
  socialConfigSchema,
  podcastConfigSchema,
  ggStackingConfigSchema,
};
