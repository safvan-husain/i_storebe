
import { z } from 'zod';

// User validation schema
export const UserRequestSchema = z.object({
  phone: z.string().min(1, { message: 'Phone is required' }),
  password: z.string().min(6, { message: 'Password must be at least 6 characters' }),
  privilege: z.enum(['admin', 'manager', 'staff']).default('staff')
});

// Lead validation schemas
export const LeadRequestSchema = z.object({
  phone: z.string().min(1, { message: 'Phone is required' }),
  name: z.string().min(1, { message: 'Name is required' }),
  email: z.string().email({ message: 'Invalid email format' }).optional(),
  source: z.string().min(1, { message: 'Source is required' }),
  enquireStatus: z.string().min(1, { message: 'Enquire status is required' }),
  purpose: z.string().min(1, { message: 'Purpose is required' }),
  address: z.string().min(1, { message: 'Address is required' }),
  manager: z.string().min(1, { message: 'Manager ID is required' }),
  dob: z.string().optional().transform(val => val ? new Date(val) : undefined)
});

export const LeadFilterSchema = z.object({
  startDate: z.string().optional().transform(val => val ? new Date(val) : undefined),
  endDate: z.string().optional().transform(val => val ? new Date(val) : undefined),
  manager: z.string().optional(),
  enquireStatus: z.string().optional(),
  source: z.string().optional(),
  purpose: z.string().optional(),
  phone: z.string().optional(),
  page: z.string().optional().transform(val => val ? parseInt(val) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val) : 10)
});

