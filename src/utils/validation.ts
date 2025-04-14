
import { z } from 'zod';
import {AppError} from "../middleware/error";


export function runtimeValidation<T>(schema: z.ZodSchema<T>, data: T): T;
export function runtimeValidation<T>(schema: z.ZodSchema<T>, data: T[]): T[];

export function runtimeValidation <T>(schema: z.ZodSchema<T>, data: T | T[])
    : T | T[]  {
    try {
        if (Array.isArray(data)) {
            // If it's an array, validate each item individually
            return data.map(item => schema.parse(item));
        } else {
            // If it's a single object
            return schema.parse(data);
        }
    } catch (e) {
        if (e instanceof z.ZodError) {
            throw new AppError(e.errors.length > 0 ? `${e.errors[0].path[0]}: ${e.errors[0].message} while validating response` : "Response error", 500, e.errors)
        } else {
            throw new AppError("Internal server error", 500)
        }
    }
}