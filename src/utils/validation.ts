
import { z } from 'zod';

// User validation schema
export const UserRequestSchema = z.object({
  phone: z.string().min(1, { message: 'Phone is required' }),
  password: z.string().min(6, { message: 'Password must be at least 6 characters' }),
  privilege: z.enum(['admin', 'manager', 'staff']).default('staff')
});

