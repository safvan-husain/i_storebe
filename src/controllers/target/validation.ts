import { z } from 'zod';
import {
    ObjectIdSchema,
    paginationSchema,
    dateFiltersSchema,
    istUtcOffset,
    ISToUTCFromStringSchema
} from "../../common/types";


export function getMonthOnly(val?: number) : Date {
    let month = val ? new Date(val) : new Date();
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
    month: ISToUTCFromStringSchema.transform(val => {
        if(!val) return  getMonthOnly();
        return getMonthOnly(val.getTime() + istUtcOffset);
    }),
}).merge(paginationSchema);