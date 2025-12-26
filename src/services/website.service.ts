import { FastifyInstance } from 'fastify';
import { WebsiteRepository } from '../repositories/website.repository';
import { UrlHelper } from '../utils/url';
import { WebsiteStatus, Role, Prisma } from '@prisma/client';

export interface WebsiteMetrics {
  traffic?: number;
  DA?: number;
  // Captcha info
  captcha_type?: 'captcha' | 'normal';
  captcha_provider?: 'recaptcha' | 'hcaptcha'; // Only when captcha_type = 'captcha'
  cloudflare?: boolean; // Only when captcha_type = 'normal'
  // Index
  index?: 'yes' | 'no';
  // About
  about?: 'no_stacking' | 'stacking_post' | 'stacking_about';
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
  notes?: string;
  metrics?: WebsiteMetrics;
}

export interface CreateBulkWebsitesInput {
  domains: string[];
}

export interface BulkWebsiteItem {
  domain: string;
  metrics?: WebsiteMetrics;
  status?: 'RUNNING' | 'ABANDONED' | 'TESTED' | 'UNTESTED' | 'PENDING' | 'MAINTENANCE' | 'ERROR';
}

export interface CreateBulkWebsitesWithMetricsInput {
  websites: BulkWebsiteItem[];
}

export interface UpdateWebsiteInput {
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

  constructor(private fastify: FastifyInstance) {
    this.websiteRepository = new WebsiteRepository(fastify.prisma);
  }

  /**
   * Tạo 1 website
   * Permission: ADMIN, MANAGER
   */
  async createWebsite(input: CreateWebsiteInput, createdBy?: string) {
    // Extract và normalize domain
    const domain = UrlHelper.extractDomain(input.domain);

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
      status: WebsiteStatus.UNTESTED,
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
        status: WebsiteStatus.UNTESTED,
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
   * Note: Sử dụng extractDomainKeepSubdomain để giữ nguyên subdomain
   * Ví dụ: academy.worldrowing.com, 3dwarehouse.sketchup.com sẽ được giữ nguyên
   */
  async createBulkWebsitesWithMetrics(
    input: CreateBulkWebsitesWithMetricsInput,
    createdBy?: string
  ): Promise<BulkCreateResult> {
    const invalid: string[] = [];
    const validWebsites: { domain: string; metrics?: WebsiteMetrics; status?: WebsiteStatus }[] = [];

    // 1. Extract và validate domains (giữ nguyên subdomain)
    for (const item of input.websites) {
      try {
        const domain = UrlHelper.extractDomainKeepSubdomain(item.domain);
        if (domain) {
          validWebsites.push({
            domain,
            metrics: item.metrics,
            status: item.status ? (item.status as WebsiteStatus) : WebsiteStatus.UNTESTED,
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
        status: website.status || WebsiteStatus.UNTESTED,
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
   * Permission: ALL (ADMIN, MANAGER, CHECKER, VIEWER)
   */
  async findAllWebsites(params: {
    page: number;
    limit: number;
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
  }) {
    const {
      page,
      limit,
      status,
      search,
      sortBy,
      sortOrder,
      index,
      captcha_type,
      captcha_provider,
      required_gmail,
      verify,
    } = params;
    const skip = (page - 1) * limit;

    // Repository đã tối ưu với Promise.all
    const { websites, total } = await this.websiteRepository.findAll({
      skip,
      take: limit,
      status,
      search,
      sortBy,
      sortOrder,
      index,
      captcha_type,
      captcha_provider,
      required_gmail,
      verify,
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
   */
  async getWebsite(id: string) {
    const website = await this.websiteRepository.findById(id);

    if (!website) {
      throw this.fastify.httpErrors.notFound('Website not found');
    }

    return website;
  }

  /**
   * Update website
   * Permission: ADMIN, MANAGER, CHECKER
   *
   * Note:
   * - ADMIN, MANAGER: Có thể update cả status và notes
   * - CHECKER: Chỉ nên update notes (fix lỗi) và status (sau khi check)
   */
  async updateWebsite(
    id: string,
    data: UpdateWebsiteInput,
    userId: string,
    userRole: Role
  ) {
    // Check website exists
    await this.getWebsite(id);

    // Prepare update data with proper type casting for Prisma
    const updateData: Prisma.WebsiteUpdateInput = {
      ...(data.status && { status: data.status }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.metrics && { metrics: data.metrics as Prisma.InputJsonValue }),
    };

    // Update với checkerId tracking
    const updated = await this.websiteRepository.update(id, updateData, userId);

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
   */
  async getAllWebsiteIds(params: {
    status?: WebsiteStatus;
    search?: string;
    index?: 'yes' | 'no';
    captcha_type?: 'captcha' | 'normal';
    captcha_provider?: 'recaptcha' | 'hcaptcha';
    required_gmail?: 'yes' | 'no';
    verify?: 'yes' | 'no';
  }): Promise<string[]> {
    return this.websiteRepository.findAllIds(params);
  }

  /**
   * Lấy nhiều websites theo IDs
   * Permission: ALL
   */
  async getWebsitesByIds(ids: string[]) {
    return this.websiteRepository.findManyByIds(ids);
  }
}
