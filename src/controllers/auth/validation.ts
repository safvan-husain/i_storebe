import { z } from 'zod';

export const UserPrivilegeSchema = z.enum(['admin', 'manager', 'staff']);

export type UserPrivilege = z.infer<typeof UserPrivilegeSchema>;

export const UserRequestSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(10, { message: "Phone number must be at least 10 characters long"}), // Adjust min/max based on phone format requirements
  password: z.string().min(8), // Ensure a minimum length for security
  privilege: UserPrivilegeSchema.optional().default('staff'),
});

export const loginSchema = z.object({
  phone: z.string().min(10, { message: "Phone number must be at least 10 characters long"}), // Adjust min/max based on phone format requirements
  password: z.string().min(8), // Ensure a minimum length for security
});