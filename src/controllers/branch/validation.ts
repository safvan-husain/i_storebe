import { z } from 'zod';
import { ObjectIdSchema } from '../../common/types';

export const createBranchSchema = z.object({
    name: z.string().trim().min(1, { message: 'Branch name is required' }),
    managerId: ObjectIdSchema.optional(),
    staffIds: z.array(ObjectIdSchema).optional().default([]),
    location: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
    }).optional(),
    isActive: z.boolean().optional().default(true),
    confirmMove: z.boolean().optional().default(false),
});

export const updateBranchSchema = z.object({
    name: z.string().trim().min(1).optional(),
    managerId: ObjectIdSchema.nullable().optional(),
    staffIds: z.array(ObjectIdSchema).optional(),
    location: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
    }).nullable().optional(),
    isActive: z.boolean().optional(),
    confirmMove: z.boolean().optional().default(false),
}).refine(v => Object.keys(v).some(key => key !== 'confirmMove'), {
    message: 'At least one branch field is required',
});

export const addStaffSchema = z.object({
    staffIds: z.array(ObjectIdSchema).min(1, { message: 'Select at least one staff' }),
    confirmMove: z.boolean().optional().default(false),
});
