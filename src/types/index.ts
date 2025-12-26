import { User } from '@prisma/client';

// Define UserWithoutPassword type
export type UserWithoutPassword = Omit<User, 'password'>;

// Extend JWT types
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      id: string;
      email: string;
      role: string;
    };
    user: UserWithoutPassword;
  }
}

// JWT Payload khi decode token
export interface JWTPayload {
  id: string;
  email: string;
  role: string;
}

// Query parameters cho pagination
export interface PaginationQuery {
  page?: number;
  limit?: number;
}

// Query parameters cho sorting
export interface SortQuery {
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// Query parameters cho search
export interface SearchQuery {
  search?: string;
}

// Kết hợp tất cả query params
export type QueryParams = PaginationQuery & SortQuery & SearchQuery;

// Success Response structure
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

// Error Response structure
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}
