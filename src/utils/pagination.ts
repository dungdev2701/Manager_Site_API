import { PAGINATION } from '../config/constants';

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginationResult {
  skip: number;
  take: number;
  page: number;
  limit: number;
}

export class PaginationHelper {
  /**
   * Tính toán pagination parameters cho Prisma
   */
  static calculate(params: PaginationParams): PaginationResult {
    const page = Math.max(1, params.page || PAGINATION.DEFAULT_PAGE);
    const limit = Math.min(
      params.limit || PAGINATION.DEFAULT_LIMIT,
      PAGINATION.MAX_LIMIT
    );

    const skip = (page - 1) * limit;
    const take = limit;

    return {
      skip,
      take,
      page,
      limit,
    };
  }

  /**
   * Generate pagination metadata
   */
  static generateMeta(page: number, limit: number, total: number) {
    const totalPages = Math.ceil(total / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return {
      page,
      limit,
      total,
      totalPages,
      hasNextPage,
      hasPrevPage,
    };
  }
}
