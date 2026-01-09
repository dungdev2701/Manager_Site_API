import { FastifyInstance } from 'fastify';
import { WebsiteRepository } from '../repositories/website.repository';
import { AuditLogService } from './audit-log.service';
import { UrlHelper } from '../utils/url';
import { WebsiteStatus, WebsiteType, Role, Prisma } from '@prisma/client';

export interface WebsiteMetrics {
  traffic?: number;
  DA?: number;
  // Captcha info
  captcha_type?: 'captcha' | 'normal';
  captcha_provider?: 'recaptcha' | 'hcaptcha'; // Only when captcha_type = 'captcha'
  cloudflare?: boolean; // Can be true for both captcha and normal types
  // Index
  index?: 'yes' | 'no';
  // About
  about?: 'no_stacking' | 'stacking_post' | 'stacking_about' | 'long_about';
  about_max_chars?: number; // Max characters allowed for about
  // Other fields
  username?: 'unique' | 'duplicate' | 'no'; // Unique: không trùng, Duplicate: được trùng, No: không có username
  email?: 'multi' | 'no_multi';
  required_gmail?: 'yes' | 'no';
  verify?: 'yes' | 'no';
  text_link?: 'no' | 'href' | 'markdown' | 'BBCode';
  social_connect?: ('facebook' | 'twitter' | 'youtube' | 'linkedin')[];
  avatar?: 'yes' | 'no';
  cover?: 'yes' | 'no';
}

export interface CreateWebsiteInput {
  domain: string;
  types?: WebsiteType[];
  notes?: string;
  metrics?: WebsiteMetrics;
}

export interface CreateBulkWebsitesInput {
  domains: string[];
}

export interface BulkWebsiteItem {
  domain: string;
  types?: WebsiteType[];
  metrics?: WebsiteMetrics;
  status?: 'NEW' | 'CHECKING' | 'HANDING' | 'PENDING' | 'RUNNING' | 'ERROR' | 'MAINTENANCE';
}

export interface CreateBulkWebsitesWithMetricsInput {
  websites: BulkWebsiteItem[];
}

export interface UpdateWebsiteInput {
  types?: WebsiteType[];
  status?: WebsiteStatus;
  notes?: string;
  metrics?: WebsiteMetrics;
}

export interface BulkCreateResult {
  created: number;
  duplicates: string[];
  invalid: string[];
  total: number;
}

export class WebsiteService {
  private websiteRepository: WebsiteRepository;
  private auditLogService: AuditLogService;

  constructor(private fastify: FastifyInstance) {
    this.websiteRepository = new WebsiteRepository(fastify.prisma);
    this.auditLogService = new AuditLogService(fastify);
  }

  /**
   * Tạo 1 website
   * Permission: ADMIN, MANAGER, DEV
   *
   * Note: Với GG_STACKING, PODCAST type, giữ nguyên domain + path
   * Ví dụ: docs.google.com/document, drive.google.com/file/d/pdf
   */
  async createWebsite(input: CreateWebsiteInput, createdBy?: string) {
    // Xác định types
    const types = input.types || [WebsiteType.ENTITY];

    // Extract domain dựa vào type
    // GG_STACKING, PODCAST: giữ nguyên path (docs.google.com/document)
    // Các type khác: chỉ lấy domain chính
    const shouldKeepPath = types.includes(WebsiteType.GG_STACKING) || types.includes(WebsiteType.PODCAST);
    const domain = shouldKeepPath
      ? UrlHelper.extractDomainWithPath(input.domain)
      : UrlHelper.extractDomain(input.domain);

    // Check domain đã tồn tại chưa
    const existingWebsite = await this.websiteRepository.findByDomain(domain);
    if (existingWebsite) {
      throw this.fastify.httpErrors.conflict(
        `Domain "${domain}" already exists`
      );
    }

    // Tạo website mới
    const website = await this.websiteRepository.create({
      domain,
      types,
      status: WebsiteStatus.NEW,
      ...(input.notes && { notes: input.notes }),
      ...(input.metrics && { metrics: input.metrics as Prisma.InputJsonValue }),
      ...(createdBy && {
        creator: {
          connect: { id: createdBy },
        },
      }),
    });

    return website;
  }

  /**
   * Tạo nhiều websites (bulk)
   * Permission: ADMIN, MANAGER
   *
   * OPTIMIZATION:
   * - Extract domains từ URLs trong memory (không query DB)
   * - Loại bỏ duplicates trong input bằng Set (O(n))
   * - 1 query để check existing domains (IN clause)
   * - 1 bulk insert thay vì N separate inserts
   */
  async createBulkWebsites(
    input: CreateBulkWebsitesInput,
    createdBy?: string
  ): Promise<BulkCreateResult> {
    // 1. Extract unique domains (in-memory operation)
    const { domains, invalid } = UrlHelper.extractUniqueDomains(input.domains);

    if (domains.length === 0) {
      throw this.fastify.httpErrors.badRequest('No valid domains provided');
    }

    // 2. Check domains nào đã tồn tại trong DB (1 query với IN clause)
    const existingWebsites = await this.websiteRepository.findManyByDomains(
      domains
    );
    const existingDomains = new Set(existingWebsites.map((w) => w.domain));

    // 3. Lọc ra domains mới (in-memory operation)
    const newDomains = domains.filter((d) => !existingDomains.has(d));

    // 4. Bulk insert new domains (1 query thay vì N queries)
    let created = 0;
    if (newDomains.length > 0) {
      const createData = newDomains.map((domain) => ({
        domain,
        status: WebsiteStatus.NEW,
        ...(createdBy && { createdBy }),
      }));

      created = await this.websiteRepository.createMany(createData);
    }

    // 5. Return kết quả
    return {
      created,
      duplicates: Array.from(existingDomains),
      invalid,
      total: input.domains.length,
    };
  }

  /**
   * Tạo nhiều websites với metrics đầy đủ (bulk import từ Excel)
   * Permission: ADMIN, MANAGER
   *
   * Note:
   * - GG_STACKING, PODCAST: giữ nguyên domain + path (docs.google.com/document)
   * - Các type khác: giữ subdomain nhưng bỏ path (academy.worldrowing.com)
   */
  async createBulkWebsitesWithMetrics(
    input: CreateBulkWebsitesWithMetricsInput,
    createdBy?: string
  ): Promise<BulkCreateResult> {
    const invalid: string[] = [];
    const validWebsites: { domain: string; types?: WebsiteType[]; metrics?: WebsiteMetrics; status?: WebsiteStatus }[] = [];

    // 1. Extract và validate domains
    for (const item of input.websites) {
      try {
        const types = item.types || [WebsiteType.ENTITY];
        const shouldKeepPath = types.includes(WebsiteType.GG_STACKING) || types.includes(WebsiteType.PODCAST);

        // GG_STACKING, PODCAST: giữ nguyên path
        // Các type khác: chỉ giữ subdomain, bỏ path
        const domain = shouldKeepPath
          ? UrlHelper.extractDomainWithPath(item.domain)
          : UrlHelper.extractDomainKeepSubdomain(item.domain);

        if (domain) {
          validWebsites.push({
            domain,
            types,
            metrics: item.metrics,
            status: item.status ? (item.status as WebsiteStatus) : WebsiteStatus.NEW,
          });
        } else {
          invalid.push(item.domain);
        }
      } catch {
        invalid.push(item.domain);
      }
    }

    // Remove duplicates trong input
    const uniqueWebsites = Array.from(
      new Map(validWebsites.map((w) => [w.domain, w])).values()
    );

    if (uniqueWebsites.length === 0) {
      throw this.fastify.httpErrors.badRequest('No valid domains provided');
    }

    // 2. Check domains nào đã tồn tại trong DB
    const domains = uniqueWebsites.map((w) => w.domain);
    const existingWebsites = await this.websiteRepository.findManyByDomains(domains);
    const existingDomains = new Set(existingWebsites.map((w) => w.domain));

    // 3. Lọc ra websites mới
    const newWebsites = uniqueWebsites.filter((w) => !existingDomains.has(w.domain));

    // 4. Bulk insert new websites với metrics
    let created = 0;
    if (newWebsites.length > 0) {
      const createData = newWebsites.map((website) => ({
        domain: website.domain,
        types: website.types || [WebsiteType.ENTITY],
        status: website.status || WebsiteStatus.NEW,
        ...(website.metrics && { metrics: website.metrics as Prisma.InputJsonValue }),
        ...(createdBy && { createdBy }),
      }));

      created = await this.websiteRepository.createMany(createData);
    }

    // 5. Return kết quả
    return {
      created,
      duplicates: Array.from(existingDomains),
      invalid,
      total: input.websites.length,
    };
  }

  /**
   * Lấy danh sách websites với pagination, filtering và sorting
   * Permission: ALL (ADMIN, MANAGER, DEV, CTV, CHECKER)
   * Note: CTV chỉ xem được websites do chính họ tạo
   */
  async findAllWebsites(params: {
    page: number;
    limit: number;
    type?: WebsiteType;
    status?: WebsiteStatus;
    search?: string;
    // Sort options
    sortBy?: 'traffic' | 'DA' | 'createdAt' | 'status';
    sortOrder?: 'asc' | 'desc';
    // Filter by metrics
    index?: 'yes' | 'no';
    captcha_type?: 'captcha' | 'normal';
    captcha_provider?: 'recaptcha' | 'hcaptcha';
    required_gmail?: 'yes' | 'no';
    verify?: 'yes' | 'no';
    // Filter by date range
    startDate?: string;
    endDate?: string;
    // User info for role-based filtering
    userId?: string;
    userRole?: Role;
  }) {
    const {
      page,
      limit,
      type,
      status,
      search,
      sortBy,
      sortOrder,
      index,
      captcha_type,
      captcha_provider,
      required_gmail,
      verify,
      startDate,
      endDate,
      userId,
      userRole,
    } = params;
    const skip = (page - 1) * limit;

    // CTV chỉ xem được websites do chính họ tạo
    const createdBy = userRole === Role.CTV ? userId : undefined;

    // Repository đã tối ưu với Promise.all
    const { websites, total } = await this.websiteRepository.findAll({
      skip,
      take: limit,
      type,
      status,
      search,
      sortBy,
      sortOrder,
      index,
      captcha_type,
      captcha_provider,
      required_gmail,
      verify,
      startDate,
      endDate,
      createdBy,
    });

    return {
      data: websites,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Lấy chi tiết 1 website
   * Permission: ALL
   * Note: CTV chỉ xem được website do chính họ tạo
   */
  async getWebsite(id: string, userId?: string, userRole?: Role) {
    const website = await this.websiteRepository.findById(id);

    if (!website) {
      throw this.fastify.httpErrors.notFound('Website not found');
    }

    // CTV chỉ xem được website do chính họ tạo
    if (userRole === Role.CTV && website.createdBy !== userId) {
      throw this.fastify.httpErrors.forbidden(
        'CTV chỉ được xem website do chính mình tạo'
      );
    }

    return website;
  }

  /**
   * Update website
   * Permission: ADMIN, MANAGER, CHECKER, CTV
   *
   * Note:
   * - ADMIN, MANAGER: Có thể update cả status và notes
   * - CHECKER: Chỉ nên update notes (fix lỗi) và status (sau khi check)
   * - CTV: Chỉ được update websites do chính họ tạo
   */
  async updateWebsite(
    id: string,
    data: UpdateWebsiteInput,
    userId: string,
    userRole: Role,
    requestInfo?: { ipAddress?: string; userAgent?: string }
  ) {
    // Check website exists và kiểm tra quyền (CTV chỉ update được website của mình)
    const oldWebsite = await this.getWebsite(id, userId, userRole);

    // Prepare update data with proper type casting for Prisma
    const updateData: Prisma.WebsiteUpdateInput = {
      ...(data.types && { types: data.types }),
      ...(data.status && { status: data.status }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.metrics && { metrics: data.metrics as Prisma.InputJsonValue }),
    };

    // Update với checkerId tracking
    const updated = await this.websiteRepository.update(id, updateData, userId);

    // Log the change to AuditLog
    await this.auditLogService.logWebsiteUpdate(
      id,
      {
        types: oldWebsite.types,
        status: oldWebsite.status,
        notes: oldWebsite.notes,
        metrics: oldWebsite.metrics,
      },
      {
        types: updated.types,
        status: updated.status,
        notes: updated.notes,
        metrics: updated.metrics,
      },
      userId,
      requestInfo?.ipAddress,
      requestInfo?.userAgent
    );

    return updated;
  }

  /**
   * Soft delete website (xóa mềm)
   * Permission: ADMIN only
   * Website sẽ được xóa vĩnh viễn sau 30 ngày
   */
  async deleteWebsite(id: string) {
    // Check website exists
    await this.getWebsite(id);

    // Soft delete
    await this.websiteRepository.softDelete(id);

    return { success: true, message: 'Website moved to trash. It will be permanently deleted after 30 days.' };
  }

  /**
   * Khôi phục website đã bị xóa mềm
   * Permission: ADMIN only
   */
  async restoreWebsite(id: string) {
    // Restore directly - Prisma will throw error if not found
    const restored = await this.websiteRepository.restore(id);
    return restored;
  }

  /**
   * Xóa vĩnh viễn website
   * Permission: ADMIN only
   */
  async permanentlyDeleteWebsite(id: string) {
    await this.websiteRepository.hardDelete(id);
    return { success: true };
  }

  /**
   * Lấy danh sách websites đã bị xóa (trash)
   * Permission: ADMIN only
   */
  async findDeletedWebsites(params: {
    page: number;
    limit: number;
    search?: string;
  }) {
    const { page, limit, search } = params;
    const skip = (page - 1) * limit;

    const { websites, total } = await this.websiteRepository.findDeleted({
      skip,
      take: limit,
      search,
    });

    return {
      data: websites,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Cleanup job: Xóa vĩnh viễn các websites đã bị soft delete quá 30 ngày
   */
  async cleanupExpiredWebsites() {
    const count = await this.websiteRepository.permanentlyDeleteExpired();
    return { deletedCount: count };
  }

  /**
   * Thống kê websites theo status
   * Permission: ALL
   */
  async getStatistics() {
    return this.websiteRepository.countByStatus();
  }

  /**
   * Lấy tất cả website IDs dựa trên filter
   * Permission: ALL
   * Note: CTV chỉ lấy được IDs của websites do chính họ tạo
   */
  async getAllWebsiteIds(params: {
    type?: WebsiteType;
    status?: WebsiteStatus;
    search?: string;
    index?: 'yes' | 'no';
    captcha_type?: 'captcha' | 'normal';
    captcha_provider?: 'recaptcha' | 'hcaptcha';
    required_gmail?: 'yes' | 'no';
    verify?: 'yes' | 'no';
    // User info for role-based filtering
    userId?: string;
    userRole?: Role;
  }): Promise<string[]> {
    const { userId, userRole, ...filterParams } = params;

    // CTV chỉ lấy được IDs của websites do chính họ tạo
    const createdBy = userRole === Role.CTV ? userId : undefined;

    return this.websiteRepository.findAllIds({
      ...filterParams,
      createdBy,
    });
  }

  /**
   * Lấy nhiều websites theo IDs
   * Permission: ALL
   */
  async getWebsitesByIds(ids: string[]) {
    return this.websiteRepository.findManyByIds(ids);
  }
}
