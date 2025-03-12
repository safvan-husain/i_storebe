import {z} from 'zod';
import {dateFiltersSchema, ObjectIdSchema, paginationSchema} from "../../common/types";

export const activityTypeSchema = z.enum(
    [
        'task_added', 'task_updated', 'lead_added',
        'lead_updated', 'note_added', 'followup_added',
        'status_updated',
        'purpose_updated', 'check_in', 'check_out',
    ]);

export type ActivityType = z.infer<typeof activityTypeSchema>;

export const activityFilterSchema = z.object({
    manager: ObjectIdSchema.optional(),
    activityType: activityTypeSchema.optional(),
    staff: ObjectIdSchema.optional(),
    lead: ObjectIdSchema.optional(),
})
    .merge(paginationSchema).merge(dateFiltersSchema)
    .refine(v =>
            !(v.manager && v.staff),
        {message: "pass either manager or staff"})
    .refine(e => {
            console.log(e);
            return !(e.lead && Object.keys(e).length > 3);
        },
        {message: "on lead no other filters applicable"});