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

// export const istUtcOffset = 19800000;

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

// export const IstToUtsOptionalFromStringSchema = z.string().optional().refine(val => !(val && !/^-?\d+$/.test(val)), { message: "should be milliseconds since epoch"}).transform(transformOptionalDate);
// export const IstToUtsFromStringSchema = z.string().refine(val => !(val && !/^-?\d+$/.test(val)), { message: "should be milliseconds since epoch"}).transform<Date>(transformDate);


// IST offset in milliseconds (5.5 hours)
export const istUtcOffset = 19800000;

/**
 * Returns the UTC Date corresponding to the **start of the day in IST**.
 */
function getUtcStartOfIstDay(istMillis: number): Date {
    const istDate = new Date(istMillis);
    istDate.setHours(0, 0, 0, 0);
    return new Date(istDate.getTime() - istUtcOffset);
}

/**
 * Returns the UTC Date corresponding to the **end of the day in IST**.
 */
function getUtcEndOfIstDay(istMillis: number): Date {
    const istDate = new Date(istMillis);
    istDate.setHours(23, 59, 59, 999);
    return new Date(istDate.getTime() - istUtcOffset);
}

/**
 * Parses a millisecond timestamp from a string.
 */
function parseMillis(val: string): number {
    const millis = parseInt(val);
    if (isNaN(millis)) {
        throw new AppError("Invalid number for Date on request string");
    }
    return millis;
}

/**
 * Converts an IST-based timestamp string into a UTC Date.
 * This version keeps the raw Date without forcing start or end of day.
 */
function convertIstMillisToUtcDate(val: string): Date {
    const millis = parseMillis(val);
    return new Date(millis - istUtcOffset);
}

/**
 * Converts an optional IST-based timestamp string into a UTC Date or undefined.
 */
function convertOptionalIstMillisToUtcDate(val: string | undefined): Date | undefined {
    if (!val) return undefined;
    const millis = parseMillis(val);
    return new Date(millis - istUtcOffset);
}

// 👇 These two schemas are drop-in replacements for your original ones.
export const IstToUtsOptionalFromStringSchema = z.string().optional().refine(
    val => !val || /^-?\d+$/.test(val),
    { message: "Should be milliseconds since epoch" }
).transform(convertOptionalIstMillisToUtcDate);

export const IstToUtsFromStringSchema = z.string().refine(
    val => /^-?\d+$/.test(val),
    { message: "Should be milliseconds since epoch" }
).transform<Date>(convertIstMillisToUtcDate);

export const optionalDateQueryFiltersSchema = z.object({
    startDate: IstToUtsOptionalFromStringSchema.transform(date => {
        if (!date) return undefined;
        const istMillis = date.getTime() + istUtcOffset;
        return getUtcStartOfIstDay(istMillis);
    }),
    endDate: IstToUtsOptionalFromStringSchema.transform(date => {
        if (!date) return undefined;
        const istMillis = date.getTime() + istUtcOffset;
        return getUtcEndOfIstDay(istMillis);
    }),
});

export const dateFiltersSchema = z.object({
    startDate: IstToUtsFromStringSchema.transform(date => {
        const istMillis = date.getTime() + istUtcOffset;
        return getUtcStartOfIstDay(istMillis);
    }),
    endDate: IstToUtsFromStringSchema.transform(date => {
        const istMillis = date.getTime() + istUtcOffset;
        return getUtcEndOfIstDay(istMillis);
    }),
});

// export const optionalDateQueryFiltersSchema = z.object({
//     startDate: IstToUtsOptionalFromStringSchema.transform(date => {
//         if (!date) return undefined;
//
//         const startOfDay = new Date(date);
//         startOfDay.setUTCHours(0, 0, 0, 0);
//         return startOfDay;
//     }),
//     endDate: IstToUtsOptionalFromStringSchema.transform((date: Date | undefined): Date | undefined => {
//         if (!date) return undefined;
//
//         const endOfDay = new Date(date);
//         endOfDay.setUTCHours(23, 59, 59, 999);
//         return endOfDay;
//     }),
// })
//
// export const dateFiltersSchema = z.object({
//     startDate: IstToUtsFromStringSchema.transform(date => {
//         const startOfDay = new Date(date);
//         startOfDay.setUTCHours(0, 0, 0, 0);
//         return startOfDay;
//     }),
//     endDate: IstToUtsFromStringSchema.transform((date: Date): Date => {
//         const endOfDay = new Date(date);
//         endOfDay.setUTCHours(23, 59, 59, 999);
//         return endOfDay;
//     }),
// })

export const UserPrivilegeSchema = z.enum(['admin', 'manager', 'staff']);
export const secondUserPrivilegeSchema = z.enum(['super', 'call-center', 'regular'])

export type UserPrivilege = z.infer<typeof UserPrivilegeSchema>;
export type SecondUserPrivilege = z.infer<typeof secondUserPrivilegeSchema>;
