import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { logger, type LogMeta } from "../logging/logger";

function normalizeError(error: unknown) {
    if (error instanceof Error) {
        return error;
    }

    return new Error(String(error));
}

function requestMeta(req: Request): LogMeta {
    return {
        method: req.method,
        pathname: req.originalUrl || req.url,
    };
}

export const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  void logger.error("Unhandled request error", {
    ...requestMeta(req),
    status: statusCode,
    errorMessage: err.message,
    errorStack: err.stack,
  });
  res.status(statusCode);
  res.json({
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? null : err.stack,
  });
};

export class AppError {

  statusCode: number;
  body: { message: string, error?: any };

  constructor(message: string, statusCode?: number, error?: any) {
    this.statusCode = statusCode ?? 500;
    this.body = { message, error };
  }
}

export const onCatchError = (error: any, res: Response) => {
    console.error(error);
    const normalizedError = normalizeError(error);
    if (error instanceof z.ZodError) {
        void logger.error("Request validation failed", {
            ...requestMeta(res.req),
            status: 400,
            errorMessage: normalizedError.message,
            errorStack: normalizedError.stack,
            details: error.errors,
        });
        res.status(400).json({
            message: error.errors.length > 0 ?  `${error.errors[0].path[0]}: ${error.errors[0].message}` : "Validation error",
            errors: error.errors
        });
        return;
    }
    if (error instanceof AppError) {
        void logger.error("Application request error", {
            ...requestMeta(res.req),
            status: error.statusCode,
            errorMessage: error.body.message,
            errorStack: normalizedError.stack,
        });
        res.status(error.statusCode).json(error.body);
        return;
    }
    void logger.error("Request failed", {
        ...requestMeta(res.req),
        status: 500,
        errorMessage: normalizedError.message,
        errorStack: normalizedError.stack,
        details: error instanceof Error ? undefined : error,
    });
    res.status(500).json({ message: "Internal server error", error });
}
  
