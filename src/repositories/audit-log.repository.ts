import { PrismaClient, AuditLog, Prisma } from '@prisma/client';

export interface CreateAuditLogInput {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditLogFilter {
  userId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  startDate?: Date;
  endDate?: Date;
}

export class AuditLogRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create a new audit log entry
   */
  async create(data: CreateAuditLogInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        userId: data.userId,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId,
        oldValues: data.oldValues as Prisma.InputJsonValue,
        newValues: data.newValues as Prisma.InputJsonValue,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });
  }

  /**
   * Find audit logs by entity and entityId
   */
  async findByEntity(
    entity: string,
    entityId: string,
    options?: {
      skip?: number;
      take?: number;
      orderBy?: 'asc' | 'desc';
    }
  ): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: {
        entity,
        entityId,
      },
      skip: options?.skip,
      take: options?.take,
      orderBy: {
        createdAt: options?.orderBy || 'desc',
      },
    });
  }

  /**
   * Find audit logs with filters
   */
  async findMany(
    filter: AuditLogFilter,
    options?: {
      skip?: number;
      take?: number;
    }
  ): Promise<AuditLog[]> {
    const where: Prisma.AuditLogWhereInput = {};

    if (filter.userId) where.userId = filter.userId;
    if (filter.entity) where.entity = filter.entity;
    if (filter.entityId) where.entityId = filter.entityId;
    if (filter.action) where.action = filter.action;

    if (filter.startDate || filter.endDate) {
      where.createdAt = {};
      if (filter.startDate) where.createdAt.gte = filter.startDate;
      if (filter.endDate) where.createdAt.lte = filter.endDate;
    }

    return this.prisma.auditLog.findMany({
      where,
      skip: options?.skip,
      take: options?.take,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * Count audit logs with filters
   */
  async count(filter: AuditLogFilter): Promise<number> {
    const where: Prisma.AuditLogWhereInput = {};

    if (filter.userId) where.userId = filter.userId;
    if (filter.entity) where.entity = filter.entity;
    if (filter.entityId) where.entityId = filter.entityId;
    if (filter.action) where.action = filter.action;

    if (filter.startDate || filter.endDate) {
      where.createdAt = {};
      if (filter.startDate) where.createdAt.gte = filter.startDate;
      if (filter.endDate) where.createdAt.lte = filter.endDate;
    }

    return this.prisma.auditLog.count({ where });
  }

  /**
   * Get edit history for a website with user info
   * Returns all UPDATE actions for a specific website with user details
   */
  async getWebsiteEditHistory(
    websiteId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      skip?: number;
      take?: number;
    }
  ) {
    const where: Prisma.AuditLogWhereInput = {
      entity: 'Website',
      entityId: websiteId,
      action: 'UPDATE',
    };

    if (options?.startDate || options?.endDate) {
      where.createdAt = {};
      if (options.startDate) where.createdAt.gte = options.startDate;
      if (options.endDate) where.createdAt.lte = options.endDate;
    }

    const logs = await this.prisma.auditLog.findMany({
      where,
      skip: options?.skip,
      take: options?.take,
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get user info for each log
    const userIds = [...new Set(logs.map((log) => log.userId).filter(Boolean))] as string[];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    return logs.map((log) => ({
      ...log,
      user: log.userId ? userMap.get(log.userId) || null : null,
    }));
  }

  /**
   * Get all editors of a website within a date range
   * Useful for performance attribution
   */
  async getWebsiteEditors(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ) {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        entityId: websiteId,
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Get unique user IDs
    const userIds = [...new Set(logs.map((log) => log.userId).filter(Boolean))] as string[];

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Group edits by user
    const editorStats = new Map<string, {
      user: { id: string; name: string | null; email: string };
      editCount: number;
      firstEdit: Date;
      lastEdit: Date;
      edits: { createdAt: Date; oldValues: unknown; newValues: unknown }[];
    }>();

    for (const log of logs) {
      if (!log.userId) continue;

      const user = userMap.get(log.userId);
      if (!user) continue;

      if (!editorStats.has(log.userId)) {
        editorStats.set(log.userId, {
          user,
          editCount: 0,
          firstEdit: log.createdAt,
          lastEdit: log.createdAt,
          edits: [],
        });
      }

      const stats = editorStats.get(log.userId)!;
      stats.editCount++;
      stats.lastEdit = log.createdAt;
      stats.edits.push({
        createdAt: log.createdAt,
        oldValues: log.oldValues,
        newValues: log.newValues,
      });
    }

    return Array.from(editorStats.values());
  }
}
