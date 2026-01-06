import { FastifyInstance } from 'fastify';
import { AuditLogRepository, AuditLogFilter } from '../repositories/audit-log.repository';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE';

export interface LogChangeInput {
  userId?: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export class AuditLogService {
  private auditLogRepository: AuditLogRepository;

  constructor(private fastify: FastifyInstance) {
    this.auditLogRepository = new AuditLogRepository(fastify.prisma);
  }

  /**
   * Log a change to an entity
   */
  async logChange(input: LogChangeInput) {
    try {
      return await this.auditLogRepository.create({
        userId: input.userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        oldValues: input.oldValues,
        newValues: input.newValues,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch (error) {
      // Don't throw error for audit log failures - just log it
      this.fastify.log.error({ err: error }, 'Failed to create audit log');
      return null;
    }
  }

  /**
   * Log website update
   * Compares old and new values and only logs changed fields
   */
  async logWebsiteUpdate(
    websiteId: string,
    oldWebsite: Record<string, unknown>,
    newWebsite: Record<string, unknown>,
    userId?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    // Find changed fields
    const changedFields: {
      old: Record<string, unknown>;
      new: Record<string, unknown>;
    } = { old: {}, new: {} };

    // Fields to track
    const trackedFields = [
      'domain',
      'type',
      'status',
      'notes',
      'priority',
      'category',
      'tags',
      'metrics',
    ];

    for (const field of trackedFields) {
      const oldVal = oldWebsite[field];
      const newVal = newWebsite[field];

      // Compare values (JSON stringify for objects)
      const oldStr = JSON.stringify(oldVal);
      const newStr = JSON.stringify(newVal);

      if (oldStr !== newStr) {
        changedFields.old[field] = oldVal;
        changedFields.new[field] = newVal;
      }
    }

    // Only log if there are changes
    if (Object.keys(changedFields.new).length === 0) {
      return null;
    }

    return this.logChange({
      userId,
      action: 'UPDATE',
      entity: 'Website',
      entityId: websiteId,
      oldValues: changedFields.old,
      newValues: changedFields.new,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Log website creation
   */
  async logWebsiteCreate(
    websiteId: string,
    websiteData: Record<string, unknown>,
    userId?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    return this.logChange({
      userId,
      action: 'CREATE',
      entity: 'Website',
      entityId: websiteId,
      newValues: websiteData,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Log website deletion
   */
  async logWebsiteDelete(
    websiteId: string,
    websiteData: Record<string, unknown>,
    userId?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    return this.logChange({
      userId,
      action: 'DELETE',
      entity: 'Website',
      entityId: websiteId,
      oldValues: websiteData,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Get edit history for a website
   */
  async getWebsiteEditHistory(
    websiteId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      page?: number;
      limit?: number;
    }
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const skip = (page - 1) * limit;

    const [history, total] = await Promise.all([
      this.auditLogRepository.getWebsiteEditHistory(websiteId, {
        startDate: options?.startDate,
        endDate: options?.endDate,
        skip,
        take: limit,
      }),
      this.auditLogRepository.count({
        entity: 'Website',
        entityId: websiteId,
        action: 'UPDATE',
        startDate: options?.startDate,
        endDate: options?.endDate,
      }),
    ]);

    return {
      data: history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get all editors of a website within a date range
   * For performance attribution feature
   */
  async getWebsiteEditors(websiteId: string, startDate: Date, endDate: Date) {
    return this.auditLogRepository.getWebsiteEditors(websiteId, startDate, endDate);
  }

  /**
   * Get audit logs with filters
   */
  async getAuditLogs(
    filter: AuditLogFilter,
    options?: { page?: number; limit?: number }
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      this.auditLogRepository.findMany(filter, { skip, take: limit }),
      this.auditLogRepository.count(filter),
    ]);

    return {
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
