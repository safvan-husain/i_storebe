import { Request, Response, NextFunction } from "express";

export const notFound = (req: Request, res: Response, next: NextFunction) => {
  console.log("🚀 ~ notFound ~  from error.middleware");
  const err = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(err);
};
  