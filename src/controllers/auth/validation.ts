import { z } from 'zod';
import {Types} from "mongoose";

export const UserPrivilegeSchema = z.enum(['admin', 'manager', 'staff']);

export type UserPrivilege = z.infer<typeof UserPrivilegeSchema>;

export const ObjectIdSchema = z
    .string()
    .refine((v) => Types.ObjectId.isValid(v), { message: "Invalid ObjectId" });

export const UserRequestSchema = z.object({
  name: z.string(),
  phone: z.string().min(10, { message: "Phone number must be at least 10 characters long"}), // Adjust min/max based on phone format requirements
  password: z.string().min(8), // Ensure a minimum length for security
  privilege: UserPrivilegeSchema.optional().default('staff').refine((v) => v !== 'admin', { message: "Cannot crate admin"}),
  manager: z.string().refine((v) => Types.ObjectId.isValid(v), { message: "Invalid manager Id"}).optional(),
});

export const loginSchema = z.object({
  phone: z.string().min(10, { message: "Phone number must be at least 10 characters long"}), // Adjust min/max based on phone format requirements
  password: z.string().min(8), // Ensure a minimum length for security
});