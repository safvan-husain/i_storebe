import {z} from 'zod';
import {optionalDateFiltersSchema, ObjectIdSchema, paginationSchema} from "../../common/types";

export const activityTypeSchema = z.enum(
    [
        'task_added', 'task_updated', 'lead_added',
        'lead_updated', 'note_added', 'followup_added',
        'status_updated', 'completed',
        'purpose_updated', 'check_in', 'check_out',
        'lead_transfer'
    ]);

export type ActivityType = z.infer<typeof activityTypeSchema>;

export const activityFilterSchema = z.object({
    manager: z.array(ObjectIdSchema).optional(),
    activityType: z.array(activityTypeSchema).optional(),
    staff: z.array(ObjectIdSchema).optional(),
    //the lead will be used only on specific lead, it is not actually filtering.
    lead: ObjectIdSchema.optional(),
})
    .merge(paginationSchema).merge(optionalDateFiltersSchema)
    .refine(e => {
            console.log(e);
            return (!(e.lead && Object.keys(e).length > 3)) || (e.lead && e.activityType);
        },
        {message: "on lead no other filters applicable other than activityType"});

export const createNoteSchema = z.object({
    note: z.string().min(1, { message: "at least one character required"}),
    leadId: ObjectIdSchema
})