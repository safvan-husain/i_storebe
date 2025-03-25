import { z } from 'zod';
import {Types} from "mongoose";
import {ObjectIdSchema, secondUserPrivilegeSchema, UserPrivilegeSchema} from "../../common/types";

export const UserRequestSchema = z.object({
  username: z.string(),
  password: z.string().min(8), // Ensure a minimum length for security
  privilege: UserPrivilegeSchema.optional().default('staff').refine((v) => v !== 'admin', { message: "Cannot crate admin"}),
  manager: ObjectIdSchema.optional(),
  secondPrivilege: secondUserPrivilegeSchema.exclude(['super']).default('regular')
});

export const loginSchema = z.object({
  username: z.string(), // Adjust min/max based on phone format requirements
  password: z.string().min(8), // Ensure a minimum length for security
});