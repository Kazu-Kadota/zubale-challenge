import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

/** Postgres error codes worth translating into something a caller can act on. */
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const INVALID_TEXT_REPRESENTATION = '22P02';

interface PostgresDriverError extends Error {
  code?: string;
  table?: string;
  detail?: string;
}

/**
 * Ensures a failure reaching the client is always something it can act on.
 *
 * Without this, any non-HttpException — a constraint violation, a malformed
 * value that slipped past validation — reaches the caller as a bare
 * "Internal server error" while the full driver dump goes to the log. The
 * caller cannot tell a permanent problem from a retryable one.
 *
 * HttpExceptions are re-emitted unchanged so the existing response shape,
 * including ValidationPipe's field-level messages, is preserved exactly.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const httpException = this.toHttpException(exception);
    const status = httpException.getStatus();

    // The original exception carries the detail worth keeping; the translated
    // one only carries what is safe to hand back.
    const serverErrorThreshold: number = HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= serverErrorThreshold) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${status}: ${httpException.message}`,
      );
    }

    const body = httpException.getResponse();
    response
      .status(status)
      .json(
        typeof body === 'string' ? { statusCode: status, message: body } : body,
      );
  }

  private toHttpException(exception: unknown): HttpException {
    if (exception instanceof HttpException) {
      return exception;
    }

    if (exception instanceof QueryFailedError) {
      return this.translateDriverError(
        exception as QueryFailedError<PostgresDriverError>,
      );
    }

    return new InternalServerErrorException();
  }

  private translateDriverError(
    exception: QueryFailedError<PostgresDriverError>,
  ): HttpException {
    const driverError: PostgresDriverError | undefined = exception.driverError;

    switch (driverError?.code) {
      case FOREIGN_KEY_VIOLATION:
        return new ConflictException(
          driverError.table
            ? `Cannot complete the request: this record is still referenced by "${driverError.table}".`
            : 'Cannot complete the request: this record is still referenced by other data.',
        );

      case UNIQUE_VIOLATION:
        return new ConflictException(
          'Cannot complete the request: a record with these values already exists.',
        );

      // Validation should reject these at the door; this is a backstop for any
      // route that has not been covered yet.
      case INVALID_TEXT_REPRESENTATION:
        return new HttpException(
          {
            statusCode: HttpStatus.BAD_REQUEST,
            message:
              'One or more values are not valid for their expected type.',
            error: 'Bad Request',
          },
          HttpStatus.BAD_REQUEST,
        );

      default:
        return new InternalServerErrorException();
    }
  }
}
