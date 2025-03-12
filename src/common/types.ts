import {z} from "zod";
import {Types} from "mongoose";

export const ObjectIdSchema = z
    .string()
    .refine((v) => Types.ObjectId.isValid(v), { message: "Invalid ObjectId" });

export const paginationSchema = z.object({
    skip: z.string().optional().transform(val => val ? parseInt(val) : 0),
    limit: z.string().optional().transform(val => val ? parseInt(val) : 20)
})

const istUtcOffset = 19800000;

function transformDate(val: string | undefined): (Date | undefined) {
    if (!val) {
        return undefined;
    }
    let millisecondInIst = parseInt(val);
    if (isNaN(millisecondInIst)) {
        return undefined;
    }
    return new Date(millisecondInIst - istUtcOffset);
}

const ISToUTCFromStringSchema = z.string().optional().refine(val => !(val && !/^-?\d+$/.test(val)), { message: "should be milliseconds since epoch"}).transform(transformDate);

export const dateFiltersSchema = z.object({
    startDate: ISToUTCFromStringSchema,
    endDate: ISToUTCFromStringSchema,
})

export const UserPrivilegeSchema = z.enum(['admin', 'manager', 'staff']);

export type UserPrivilege = z.infer<typeof UserPrivilegeSchema>;