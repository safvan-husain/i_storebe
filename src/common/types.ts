import {z} from "zod";
import {Types} from "mongoose";
import {AppError} from "../middleware/error";

export const ObjectIdSchema = z
    .string()
    .refine((v) => Types.ObjectId.isValid(v), { message: "Invalid ObjectId" });

export const paginationSchema = z.object({
    skip: z.string().optional().transform(val => val ? parseInt(val) : 0),
    limit: z.string().optional().transform(val => val ? parseInt(val) : 20)
})

export const istUtcOffset = 19800000;

//transforming from milliseconds to date from flutter app it will be IST so converting it into UTC, since mongodb use UTC by default.
function transformOptionalDate(val: string | undefined): (Date | undefined) {
    if (!val) {
        return undefined;
    }
    let millisecondInIst = parseInt(val);
    if (isNaN(millisecondInIst)) {
        return undefined;
    }
    return new Date(millisecondInIst - istUtcOffset);
}

function transformDate(val: string ): Date {
    let millisecondInIst = parseInt(val);
    if (isNaN(millisecondInIst)) {
        throw new AppError("Invalid number for Date on request string");
    }
    return new Date(millisecondInIst - istUtcOffset);
}

export const IstToUtsOptionalFromStringSchema = z.string().optional().refine(val => !(val && !/^-?\d+$/.test(val)), { message: "should be milliseconds since epoch"}).transform(transformOptionalDate);
export const IstToUtsFromStringSchema = z.string().refine(val => !(val && !/^-?\d+$/.test(val)), { message: "should be milliseconds since epoch"}).transform<Date>(transformDate);

export const optionalDateFiltersSchema = z.object({
    startDate: IstToUtsOptionalFromStringSchema.transform(date => {
        if (!date) return undefined;

        const startOfDay = new Date(date);
        startOfDay.setUTCHours(0, 0, 0, 0);
        return startOfDay;
    }),
    endDate: IstToUtsOptionalFromStringSchema.transform((date: Date | undefined): Date | undefined => {
        if (!date) return undefined;

        const endOfDay = new Date(date);
        endOfDay.setUTCHours(23, 59, 59, 999);
        return endOfDay;
    }),
})

export const dateFiltersSchema = z.object({
    startDate: IstToUtsFromStringSchema.transform(date => {
        const startOfDay = new Date(date);
        startOfDay.setUTCHours(0, 0, 0, 0);
        return startOfDay;
    }),
    endDate: IstToUtsFromStringSchema.transform((date: Date): Date => {
        const endOfDay = new Date(date);
        endOfDay.setUTCHours(23, 59, 59, 999);
        return endOfDay;
    }),
})

export const UserPrivilegeSchema = z.enum(['admin', 'manager', 'staff']);
export const secondUserPrivilegeSchema = z.enum(['super', 'call-center', 'regular'])

export type UserPrivilege = z.infer<typeof UserPrivilegeSchema>;
export type SecondUserPrivilege = z.infer<typeof secondUserPrivilegeSchema>;
