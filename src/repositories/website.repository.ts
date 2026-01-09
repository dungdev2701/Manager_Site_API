import { PrismaClient, Website, Prisma, WebsiteStatus, WebsiteType } from '@prisma/client';

export class WebsiteRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Tạo 1 website
   */
  async create(data: Prisma.WebsiteCreateInput): Promise<Website> {
    return this.prisma.website.create({ data });
  }

  /**
   * Tạo nhiều websites cùng lúc (bulk insert)
   * OPTIMIZATION: Sử dụng createMany thay vì multiple create() → 1 DB query thay vì N queries
   */
  async createMany(data: Prisma.WebsiteCreateManyInput[]): Promise<number> {
    const result = await this.prisma.website.createMany({
      data,
      skipDuplicates: true, // Bỏ qua nếu domain đã tồn tại (unique constraint)
    });
    return result.count; // Số lượng records được tạo
  }

  /**
   * Tìm website theo domain
   */
  async findByDomain(domain: string): Promise<Website | null> {
    return this.prisma.website.findUnique({
      where: { domain },
    });
  }

  /**
   * Tìm nhiều websites theo domains
   * OPTIMIZATION: 1 query với IN clause thay vì N queries
   */
  async findManyByDomains(domains: string[]) {
    return this.prisma.website.findMany({
      where: {
        domain: { in: domains },
      },
      select: {
        id: true,
        domain: true,
        status: true,
        createdAt: true,
      },
    });
  }

  /**
   * Lấy danh sách TẤT CẢ websites (không filter theo userId)
   * OPTIMIZATION:
   * - Sử dụng select để chỉ lấy fields cần thiết
   * - Parallel queries với Promise.all để giảm thời gian response
   * - Supports filtering by metrics fields (JSONB)
   * - Supports sorting by metrics fields
   */
  async findAll(params: {
    skip?: number;
    take?: number;
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
    // Filter by ownership (for CTV)
    createdBy?: string;
  }) {
    const {
      skip,
      take,
      type,
      status,
      search,
      sortBy,
      sortOrder = 'desc',
      index,
      captcha_type,
      captcha_provider,
      required_gmail,
      verify,
      startDate,
      endDate,
      createdBy,
    } = params;

    // Build date range filter
    let createdAtFilter: { gte?: Date; lte?: Date } | undefined;
    if (startDate || endDate) {
      createdAtFilter = {};
      if (startDate) {
        createdAtFilter.gte = new Date(startDate);
      }
      if (endDate) {
        // Set to end of day
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        createdAtFilter.lte = endOfDay;
      }
    }

    // Build where clause with metrics filters
    const where: Prisma.WebsiteWhereInput = {
      deletedAt: null, // Only get active websites (not soft deleted)
      ...(type && { types: { has: type } }),
      ...(status && { status }),
      ...(search && {
        domain: {
          contains: search,
          mode: 'insensitive' as Prisma.QueryMode,
        },
      }),
      // Filter by date range
      ...(createdAtFilter && { createdAt: createdAtFilter }),
      // Filter by ownership (for CTV role)
      ...(createdBy && { createdBy }),
    };

    // Add metrics filters using Prisma's JSON filtering
    const metricsFilters: Prisma.JsonFilter[] = [];

    if (index) {
      metricsFilters.push({ path: ['index'], equals: index });
    }
    if (captcha_type) {
      metricsFilters.push({ path: ['captcha_type'], equals: captcha_type });
    }
    if (captcha_provider) {
      metricsFilters.push({ path: ['captcha_provider'], equals: captcha_provider });
    }
    if (required_gmail) {
      metricsFilters.push({ path: ['required_gmail'], equals: required_gmail });
    }
    if (verify) {
      metricsFilters.push({ path: ['verify'], equals: verify });
    }

    // Apply metrics filters if any
    if (metricsFilters.length > 0) {
      where.AND = metricsFilters.map(filter => ({
        metrics: filter,
      }));
    }

    // Build orderBy clause
    // Default sort by traffic (desc) if no sortBy specified
    const effectiveSortBy = sortBy || 'traffic';
    let orderBy: Prisma.WebsiteOrderByWithRelationInput = { createdAt: 'desc' };
    if (effectiveSortBy === 'createdAt') {
      orderBy = { createdAt: sortOrder };
    } else if (effectiveSortBy === 'status') {
      orderBy = { status: sortOrder };
    }
    // Note: For JSONB fields (traffic, DA), we'll sort in memory after fetching
    // because Prisma doesn't support direct JSONB field ordering
    const needsJsonSort = effectiveSortBy === 'traffic' || effectiveSortBy === 'DA';

    // OPTIMIZATION: Chạy 2 queries song song thay vì tuần tự
    const [websites, total] = await Promise.all([
      this.prisma.website.findMany({
        where,
        skip: needsJsonSort ? undefined : skip, // Fetch all if we need to sort by JSON field
        take: needsJsonSort ? undefined : take,
        orderBy,
        select: {
          id: true,
          domain: true,
          types: true,
          status: true,
          notes: true,
          metrics: true,
          priority: true,
          category: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
          lastCheckedAt: true,
          // Include creator info (optional)
          creator: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          // Include checker info
          checker: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          // Include latest stats for success rate
          stats: {
            select: {
              successRate: true,
              totalAttempts: true,
              successCount: true,
              failureCount: true,
            },
            orderBy: { periodStart: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.website.count({ where }),
    ]);

    // Transform websites to include successRate at top level
    let websitesWithStats = websites.map((website) => {
      const latestStats = (website as typeof website & { stats: { successRate: number; totalAttempts: number; successCount: number; failureCount: number }[] }).stats[0];
      return {
        ...website,
        successRate: latestStats?.successRate ?? null,
        totalAttempts: latestStats?.totalAttempts ?? 0,
        stats: undefined, // Remove nested stats
      };
    });

    // Sort by JSON field if needed
    if (needsJsonSort) {
      websitesWithStats.sort((a, b) => {
        const metricsA = a.metrics as Record<string, unknown> | null;
        const metricsB = b.metrics as Record<string, unknown> | null;
        const valueA = (metricsA?.[effectiveSortBy] as number) ?? 0;
        const valueB = (metricsB?.[effectiveSortBy] as number) ?? 0;

        if (sortOrder === 'desc') {
          return valueB - valueA;
        }
        return valueA - valueB;
      });

      // Apply pagination after sorting
      if (skip !== undefined || take !== undefined) {
        const startIndex = skip || 0;
        const endIndex = take ? startIndex + take : undefined;
        websitesWithStats = websitesWithStats.slice(startIndex, endIndex);
      }
    }

    return { websites: websitesWithStats, total };
  }

  /**
   * Tìm website theo ID (chỉ lấy website chưa bị xóa)
   */
  async findById(id: string): Promise<Website | null> {
    return this.prisma.website.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: {
          select: { id: true, name: true, email: true },
        },
        checker: {
          select: { id: true, name: true, email: true },
        },
      },
    });
  }

  /**
   * Update website
   * OPTIMIZATION: Tự động update lastCheckedAt khi có sự thay đổi
   */
  async update(
    id: string,
    data: Prisma.WebsiteUpdateInput,
    checkerId?: string
  ): Promise<Website> {
    const updateData: Prisma.WebsiteUpdateInput = {
      ...data,
      lastCheckedAt: new Date(), // Auto update timestamp
    };

    if (checkerId) {
      updateData.checker = {
        connect: { id: checkerId },
      };
    }

    return this.prisma.website.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * Soft delete website - đánh dấu deletedAt thay vì xóa thật
   */
  async softDelete(id: string): Promise<Website> {
    return this.prisma.website.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Khôi phục website đã bị soft delete
   */
  async restore(id: string): Promise<Website> {
    return this.prisma.website.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /**
   * Xóa vĩnh viễn website (hard delete)
   */
  async hardDelete(id: string): Promise<Website> {
    return this.prisma.website.delete({
      where: { id },
    });
  }

  /**
   * Lấy danh sách websites đã bị soft delete
   */
  async findDeleted(params: {
    skip?: number;
    take?: number;
    search?: string;
  }) {
    const { skip, take, search } = params;

    const where: Prisma.WebsiteWhereInput = {
      deletedAt: { not: null },
      ...(search && {
        domain: {
          contains: search,
          mode: 'insensitive' as Prisma.QueryMode,
        },
      }),
    };

    const [websites, total] = await Promise.all([
      this.prisma.website.findMany({
        where,
        skip,
        take,
        orderBy: { deletedAt: 'desc' },
        select: {
          id: true,
          domain: true,
          types: true,
          status: true,
          notes: true,
          metrics: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.website.count({ where }),
    ]);

    return { websites, total };
  }

  /**
   * Xóa vĩnh viễn các websites đã bị soft delete quá 30 ngày
   */
  async permanentlyDeleteExpired(): Promise<number> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await this.prisma.website.deleteMany({
      where: {
        deletedAt: {
          not: null,
          lte: thirtyDaysAgo,
        },
      },
    });

    return result.count;
  }

  /**
   * Đếm số lượng websites theo status (toàn hệ thống, chỉ đếm active)
   * OPTIMIZATION: Sử dụng groupBy thay vì multiple count queries
   */
  async countByStatus(): Promise<Record<string, number>> {
    const counts = await this.prisma.website.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: true,
    });

    const result: Record<string, number> = {
      NEW: 0,
      CHECKING: 0,
      HANDING: 0,
      PENDING: 0,
      RUNNING: 0,
      ERROR: 0,
      MAINTENANCE: 0,
    };

    counts.forEach((item) => {
      result[item.status] = item._count;
    });

    return result;
  }

  /**
   * Lấy tất cả website IDs dựa trên filter
   */
  async findAllIds(params: {
    type?: WebsiteType;
    status?: WebsiteStatus;
    search?: string;
    index?: 'yes' | 'no';
    captcha_type?: 'captcha' | 'normal';
    captcha_provider?: 'recaptcha' | 'hcaptcha';
    required_gmail?: 'yes' | 'no';
    verify?: 'yes' | 'no';
    // Filter by ownership (for CTV)
    createdBy?: string;
  }): Promise<string[]> {
    const {
      type,
      status,
      search,
      index,
      captcha_type,
      captcha_provider,
      required_gmail,
      verify,
      createdBy,
    } = params;

    // Build where clause with metrics filters
    const where: Prisma.WebsiteWhereInput = {
      deletedAt: null,
      ...(type && { types: { has: type } }),
      ...(status && { status }),
      ...(search && {
        domain: {
          contains: search,
          mode: 'insensitive' as Prisma.QueryMode,
        },
      }),
      // Filter by ownership (for CTV role)
      ...(createdBy && { createdBy }),
    };

    // Add metrics filters
    const metricsFilters: Prisma.JsonFilter[] = [];
    if (index) {
      metricsFilters.push({ path: ['index'], equals: index });
    }
    if (captcha_type) {
      metricsFilters.push({ path: ['captcha_type'], equals: captcha_type });
    }
    if (captcha_provider) {
      metricsFilters.push({ path: ['captcha_provider'], equals: captcha_provider });
    }
    if (required_gmail) {
      metricsFilters.push({ path: ['required_gmail'], equals: required_gmail });
    }
    if (verify) {
      metricsFilters.push({ path: ['verify'], equals: verify });
    }

    if (metricsFilters.length > 0) {
      where.AND = metricsFilters.map(filter => ({
        metrics: filter,
      }));
    }

    const websites = await this.prisma.website.findMany({
      where,
      select: { id: true },
    });

    return websites.map(w => w.id);
  }

  /**
   * Lấy nhiều websites theo IDs với đầy đủ thông tin
   */
  async findManyByIds(ids: string[]) {
    return this.prisma.website.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      select: {
        id: true,
        domain: true,
        types: true,
        status: true,
        notes: true,
        metrics: true,
        priority: true,
        category: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        lastCheckedAt: true,
        creator: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        checker: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
  }
}
