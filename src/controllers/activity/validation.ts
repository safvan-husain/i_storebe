import {z} from 'zod';
import {optionalDateQueryFiltersSchema, ObjectIdSchema, paginationSchema} from "../../common/types";

export const activityTypeSchema = z.enum(
    [
        'task_added', 'task_updated', 'lead_added',
        'lead_updated', 'note_added', 'followup_added',
        'status_updated', 'made_won', 'removed_won', 'completed',
        'purpose_updated', 'check_in', 'check_out',
        'lead_transfer', 'call_status_updated', 'dialed',
        'branch_created', 'branch_updated', 'branch_staff_added',
        'branch_staff_removed', 'branch_staff_transferred',
        'branch_location_updated', 'branch_activated', 'branch_inactivated'
    ]);

export type ActivityType = z.infer<typeof activityTypeSchema>;

export const activityFilterSchema = z.object({
    manager: z.array(ObjectIdSchema).optional(),
    activityType: z.array(activityTypeSchema).optional(),
    staff: z.array(ObjectIdSchema).optional(),
    //the lead will be used only on specific lead, it is not actually filtering.
    lead: ObjectIdSchema.optional(),
})
    .merge(paginationSchema).merge(optionalDateQueryFiltersSchema)
    .refine(e => {
            console.log(e);
            return (!(e.lead && Object.keys(e).length > 3)) || (e.lead && e.activityType);
        },
        {message: "on lead no other filters applicable other than activityType"});

export const createNoteSchema = z.object({
    note: z.string().min(1, { message: "at least one character required"}),
    leadId: ObjectIdSchema
})

export const callReportsRequestSchema = z
    .object({
        managerId: ObjectIdSchema.optional(),
        staffId: ObjectIdSchema.optional(),
    }).merge(optionalDateQueryFiltersSchema)


export const statsSchema = z.object({
    _id: z.string(),
    task_added: z.number().default(0),
    lead_added: z.number().default(0),
    status_updated: z.number().default(0),
    made_won: z.number().default(0),
    removed_won: z.number().default(0),
    call_status_updated: z.number().default(0),
    total_leads: z.number().default(0),
    is_won: z.number().default(0),
    is_visited: z.number().default(0),
    pending_tasks: z.number().default(0),
    overdue_tasks: z.number().default(0)
});
