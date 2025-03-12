import { z } from 'zod';
import {ObjectIdSchema, paginationSchema, dateFiltersSchema} from "../../common/types";

const categorySchema = z.enum(['call', 'sales', 'meeting'])

export type Category = z.infer<typeof categorySchema>

export const TaskCreateSchema = z.object({
    lead: ObjectIdSchema,
    assigned: ObjectIdSchema,
    category: categorySchema,
    due: z.number().transform(val => new Date(val)),
    title: z.string().optional(),
    description: z.string().optional()
});

export const updateSchema = TaskCreateSchema.partial();

export const TaskFilterSchema = z.object({
    lead: ObjectIdSchema.optional(),
    assigned: ObjectIdSchema.optional(),
    manager: ObjectIdSchema.optional(),
    category: categorySchema.optional(),
}).merge(paginationSchema).merge(dateFiltersSchema);