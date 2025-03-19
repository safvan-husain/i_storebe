import { z } from 'zod';
import {
    ObjectIdSchema,
    paginationSchema,
    dateFiltersSchema,
    istUtcOffset,
    ISToUTCFromStringSchema
} from "../../common/types";


function getMonthOnly(val: number) : Date {
    let month = new Date(val);
    //we only care about year and month.
    month.setUTCHours(0, 0, 0, 0);
    month.setUTCMonth(month.getMonth())
    month.setUTCFullYear(month.getFullYear())
    month.setUTCDate(1);
    return month;
}


export const TargetCreateSchema = z.object({
    assigned: ObjectIdSchema,
    //saving month in utc.
    month: z.number().transform(getMonthOnly),
    total: z.number()
});

export const TargetFilterSchema = z.object({
    assigned: ObjectIdSchema.optional(),
    manager: ObjectIdSchema.optional(),
    achieveStatus: z.boolean().optional(),
    month: ISToUTCFromStringSchema.transform(val => {
        if(!val) return  undefined;
        return getMonthOnly(val.getTime() + istUtcOffset);
    }),
}).merge(paginationSchema);