import { FastifyInstance } from 'fastify';
import { GmailStatus, Prisma } from '@prisma/client';

export interface CreateGmailInput {
  email: string;
  password: string;
  appPassword?: string;
  twoFA?: string;
  recoveryEmail?: string;
  ownerId?: string | null;
  status?: GmailStatus;
}

export interface UpdateGmailInput {
  email?: string;
  password?: string;
  appPassword?: string | null;
  twoFA?: string | null;
  recoveryEmail?: string | null;
  ownerId?: string | null;
  status?: GmailStatus;
}

export interface GmailQueryInput {
  page?: number;
  limit?: number;
  search?: string;
  status?: GmailStatus;
  ownerId?: string; // Can be UUID or 'none' for null owner
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  sortBy?: 'email' | 'createdAt' | 'status';
  sortOrder?: 'asc' | 'desc';
}

export class GmailService {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Check if email exists in the system
   */
  async checkEmailExists(email: string) {
    const gmail = await this.fastify.prisma.gmail.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        status: true,
        deletedAt: true,
      },
    });

    if (!gmail) {
      return { exists: false };
    }

    return {
      exists: true,
      isDeleted: gmail.deletedAt !== null,
      status: gmail.status,
    };
  }

  /**
   * Create new gmail
   */
  async createGmail(input: CreateGmailInput) {
    // Check if email already exists
    const existingGmail = await this.fastify.prisma.gmail.findUnique({
      where: { email: input.email },
    });
    if (existingGmail) {
      throw this.fastify.httpErrors.conflict('Email already exists');
    }

    // Create gmail
    const gmail = await this.fastify.prisma.gmail.create({
      data: {
        email: input.email,
        password: input.password,
        appPassword: input.appPassword,
        twoFA: input.twoFA,
        recoveryEmail: input.recoveryEmail || null,
        ownerId: input.ownerId || null,
        status: input.status || GmailStatus.SUCCESS,
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return gmail;
  }

  /**
   * Get all gmails with pagination and filtering
   */
  async getAllGmails(query: GmailQueryInput) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.GmailWhereInput = {
      deletedAt: null,
    };

    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { recoveryEmail: { contains: query.search, mode: 'insensitive' } },
        { owner: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.ownerId) {
      if (query.ownerId === 'none') {
        where.ownerId = null;
      } else {
        where.ownerId = query.ownerId;
      }
    }

    // Date range filter
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) {
        where.createdAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        // Add 1 day to include the end date
        const endDate = new Date(query.endDate);
        endDate.setDate(endDate.getDate() + 1);
        where.createdAt.lte = endDate;
      }
    }

    // Build orderBy
    const orderBy: Prisma.GmailOrderByWithRelationInput = {};
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder || 'desc';
    orderBy[sortBy] = sortOrder;

    // Get gmails and count
    const [gmails, total] = await Promise.all([
      this.fastify.prisma.gmail.findMany({
        skip,
        take: limit,
        where,
        orderBy,
        include: {
          owner: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
          usages: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: {
              usedAt: 'desc',
            },
          },
        },
      }),
      this.fastify.prisma.gmail.count({ where }),
    ]);

    return {
      data: gmails,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get gmail by ID
   */
  async getGmailById(id: string) {
    const gmail = await this.fastify.prisma.gmail.findFirst({
      where: { id, deletedAt: null },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return gmail;
  }

  /**
   * Update gmail
   */
  async updateGmail(id: string, input: UpdateGmailInput) {
    // Check if gmail exists
    const existingGmail = await this.fastify.prisma.gmail.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existingGmail) {
      throw this.fastify.httpErrors.notFound('Gmail not found');
    }

    // Check if email is being changed and already exists
    if (input.email && input.email !== existingGmail.email) {
      const emailExists = await this.fastify.prisma.gmail.findUnique({
        where: { email: input.email },
      });
      if (emailExists) {
        throw this.fastify.httpErrors.conflict('Email already exists');
      }
    }

    // Update gmail
    const gmail = await this.fastify.prisma.gmail.update({
      where: { id },
      data: input,
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return gmail;
  }

  /**
   * Soft delete gmail
   */
  async deleteGmail(id: string) {
    // Check if gmail exists
    const existingGmail = await this.fastify.prisma.gmail.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existingGmail) {
      throw this.fastify.httpErrors.notFound('Gmail not found');
    }

    // Soft delete
    await this.fastify.prisma.gmail.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Restore gmail from trash
   */
  async restoreGmail(id: string) {
    // Check if gmail exists in trash
    const existingGmail = await this.fastify.prisma.gmail.findFirst({
      where: { id, deletedAt: { not: null } },
    });
    if (!existingGmail) {
      throw this.fastify.httpErrors.notFound('Gmail not found in trash');
    }

    // Restore
    const gmail = await this.fastify.prisma.gmail.update({
      where: { id },
      data: { deletedAt: null },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return gmail;
  }

  /**
   * Permanently delete gmail
   */
  async permanentDeleteGmail(id: string) {
    // Check if gmail exists
    const existingGmail = await this.fastify.prisma.gmail.findUnique({
      where: { id },
    });
    if (!existingGmail) {
      throw this.fastify.httpErrors.notFound('Gmail not found');
    }

    await this.fastify.prisma.gmail.delete({
      where: { id },
    });
  }

  /**
   * Check usage status for multiple gmails (does NOT create records)
   * Returns emails that have been used before
   */
  async checkUsageStatus(ids: string[]) {
    const gmails = await this.fastify.prisma.gmail.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      include: {
        usages: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            usedAt: 'desc',
          },
        },
      },
    });

    type GmailWithUsages = (typeof gmails)[number];
    type UsageWithUser = GmailWithUsages['usages'][number];

    const alreadyUsed = gmails.filter(
      (g: GmailWithUsages) => g.usages.length > 0
    );
    const neverUsed = gmails.filter(
      (g: GmailWithUsages) => g.usages.length === 0
    );

    return {
      neverUsedCount: neverUsed.length,
      alreadyUsed: alreadyUsed.map((g: GmailWithUsages) => ({
        id: g.id,
        email: g.email,
        usageCount: g.usages.length,
        users: g.usages.map((u: UsageWithUser) => ({
          id: u.user.id,
          name: u.user.name,
          usedAt: u.usedAt,
        })),
      })),
    };
  }

  /**
   * Claim ownership for multiple gmails (creates usage records)
   * - Creates usage records for exported emails
   * - Updates owner for emails without owner (first time use)
   */
  async claimOwnership(ids: string[], newOwnerId: string) {
    // Get all gmails by ids
    const gmails = await this.fastify.prisma.gmail.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      select: {
        id: true,
        ownerId: true,
      },
    });

    type GmailBasic = (typeof gmails)[number];

    // Create usage records for all exported emails
    await this.fastify.prisma.gmailUsage.createMany({
      data: gmails.map((g: GmailBasic) => ({
        gmailId: g.id,
        userId: newOwnerId,
      })),
    });

    // Update owner only for emails without owner (first time use)
    const neverUsedIds = gmails
      .filter((g: GmailBasic) => g.ownerId === null)
      .map((g: GmailBasic) => g.id);
    if (neverUsedIds.length > 0) {
      await this.fastify.prisma.gmail.updateMany({
        where: {
          id: { in: neverUsedIds },
        },
        data: {
          ownerId: newOwnerId,
        },
      });
    }

    return {
      claimed: gmails.length,
      newOwnerAssigned: neverUsedIds.length,
    };
  }
}
