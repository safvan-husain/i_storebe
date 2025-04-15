import { z } from 'zod';
import {ObjectIdSchema, paginationSchema, optionalDateQueryFiltersSchema} from "../../common/types";
import {EnquireStatus, Purpose, callStatusSchema} from "../leads/validations";
import {enquireStatusSchema} from "../statics/staticsController";

export const categorySchema = z.enum(['call', 'sales', 'meeting'])

export type Category = z.infer<typeof categorySchema>

export const TaskCreateSchema = z.object({
    lead: ObjectIdSchema,
    assigned: ObjectIdSchema.optional(),
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
}).merge(paginationSchema).merge(optionalDateQueryFiltersSchema);

export const completeTaskSchema = z.object({
    id: ObjectIdSchema,
    enquireStatus: EnquireStatus.optional(),
    purpose: Purpose.optional(),
    callStatus: callStatusSchema.optional(),
    note: z.string().optional(),
    //TODO: check ist or utc date.
    followUpDate: z.number().optional().transform(val => val ? new Date(val) : undefined),
})

export const callReportsResponseSchema = z.object({
    completedCalls: z.number().default(0),
    callStatusStatics: z.object({
        connected: z.number().default(0),
        notConnected: z.number().default(0),
        actionPending: z.number().default(0),
        notUpdated: z.number().default(0),
        followUpScheduled: z.number().default(0),
        callBackRequested: z.number().default(0),
    }).default({}),
    leadStatus: enquireStatusSchema
})

export type CallReportsRes = z.infer<typeof callReportsResponseSchema>;