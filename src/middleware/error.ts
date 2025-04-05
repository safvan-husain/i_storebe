import { Request, Response } from "express";
import { z } from "zod";


export const errorHandler = (err: Error, _: Request, res: Response) => {
  console.log("🚀 ~ errorHandler ~ err:", err);
  console.log("🤯", err.message);
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  res.status(statusCode);
  res.json({
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? null : err.stack,
  });
};

export class AppError {

  statusCode: number;
  body: { message: string };

  constructor(message: string, statusCode?: number) {
    this.statusCode = statusCode ?? 500;
    this.body = { message };
  }
}

export const onCatchError = (error: any, res: Response) => {
    if (error instanceof z.ZodError) {
        res.status(400).json({
            message: error.errors.length > 0 ?  `${error.errors[0].path[0]}: ${error.errors[0].message}` : "Validation error",
            errors: error.errors
        });
        return;
    }
    if (error instanceof AppError) {
        res.status(error.statusCode).json(error.body);
        return;
    }
    res.status(500).json({ message: "Internal server error", error });
}
  