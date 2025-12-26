import { FastifyReply } from 'fastify';
import { HTTP_STATUS } from '../config/constants';
import { SuccessResponse, ErrorResponse } from '../types';

export class ResponseHelper {
  /**
   * Success response
   */
  static success<T>(
    reply: FastifyReply,
    data: T,
    message?: string,
    statusCode: number = HTTP_STATUS.OK
  ): FastifyReply {
    const response: SuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
    };

    return reply.code(statusCode).send(response);
  }

  /**
   * Success response với pagination
   */
  static successWithPagination<T>(
    reply: FastifyReply,
    data: T,
    meta: {
      page: number;
      limit: number;
      total: number;
    },
    message?: string
  ): FastifyReply {
    const totalPages = Math.ceil(meta.total / meta.limit);

    const response: SuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
      meta: {
        ...meta,
        totalPages,
      },
    };

    return reply.code(HTTP_STATUS.OK).send(response);
  }

  /**
   * Created response (201)
   */
  static created<T>(
    reply: FastifyReply,
    data: T,
    message?: string
  ): FastifyReply {
    return this.success(reply, data, message, HTTP_STATUS.CREATED);
  }

  /**
   * No content response (204)
   */
  static noContent(reply: FastifyReply): FastifyReply {
    return reply.code(HTTP_STATUS.NO_CONTENT).send();
  }

  /**
   * Error response
   */
  static error(
    reply: FastifyReply,
    code: string,
    message: string,
    statusCode: number = HTTP_STATUS.BAD_REQUEST,
    details?: any
  ): FastifyReply {
    const response: ErrorResponse = {
      success: false,
      error: {
        code,
        message,
        ...(details && { details }),
      },
    };

    return reply.code(statusCode).send(response);
  }

  /**
   * Bad Request (400)
   */
  static badRequest(
    reply: FastifyReply,
    message: string,
    code: string = 'BAD_REQUEST'
  ): FastifyReply {
    return this.error(reply, code, message, HTTP_STATUS.BAD_REQUEST);
  }

  /**
   * Unauthorized (401)
   */
  static unauthorized(
    reply: FastifyReply,
    message: string = 'Unauthorized',
    code: string = 'UNAUTHORIZED'
  ): FastifyReply {
    return this.error(reply, code, message, HTTP_STATUS.UNAUTHORIZED);
  }

  /**
   * Forbidden (403)
   */
  static forbidden(
    reply: FastifyReply,
    message: string = 'Forbidden',
    code: string = 'FORBIDDEN'
  ): FastifyReply {
    return this.error(reply, code, message, HTTP_STATUS.FORBIDDEN);
  }

  /**
   * Not Found (404)
   */
  static notFound(
    reply: FastifyReply,
    message: string = 'Resource not found',
    code: string = 'NOT_FOUND'
  ): FastifyReply {
    return this.error(reply, code, message, HTTP_STATUS.NOT_FOUND);
  }

  /**
   * Conflict (409)
   */
  static conflict(
    reply: FastifyReply,
    message: string,
    code: string = 'CONFLICT'
  ): FastifyReply {
    return this.error(reply, code, message, HTTP_STATUS.CONFLICT);
  }

  /**
   * Validation Error (422)
   */
  static validationError(
    reply: FastifyReply,
    details: any
  ): FastifyReply {
    return this.error(
      reply,
      'VALIDATION_ERROR',
      'Validation failed',
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      details
    );
  }

  /**
   * Internal Server Error (500)
   */
  static internalError(
    reply: FastifyReply,
    message: string = 'Internal server error'
  ): FastifyReply {
    return this.error(
      reply,
      'INTERNAL_ERROR',
      message,
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    );
  }
}
