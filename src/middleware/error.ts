import { Request, Response } from "express";


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
  