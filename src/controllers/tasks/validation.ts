import { z } from 'zod';
import {ObjectIdSchema, paginationSchema, optionalDateFiltersSchema} from "../../common/types";
import {EnquireStatus, Purpose, callStatusSchema} from "../leads/validations";

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
    assigned: z.array(ObjectIdSchema).optional(),
    managers: z.array(ObjectIdSchema).optional(),
    category: categorySchema.optional(),
}).merge(paginationSchema).merge(optionalDateFiltersSchema);

export const completeTaskSchema = z.object({
    id: ObjectIdSchema,
    enquireStatus: EnquireStatus.optional(),
    purpose: Purpose.optional(),
    callStatus: callStatusSchema.optional(),
    note: z.string().optional(),
    //TODO: check ist or utc date.
    followUpDate: z.number().optional().transform(val => val ? new Date(val) : undefined),
})