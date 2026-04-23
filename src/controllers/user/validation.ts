import { z } from 'zod';
import {ObjectIdSchema, secondUserPrivilegeSchema, UserPrivilegeSchema} from "../../common/types";

export const getStaffRequestSchema = z.object({
    manager: ObjectIdSchema.optional()
})

export const employeeQuerySchema = z.object({
    active: z.boolean().optional(),
    branchId: ObjectIdSchema.optional(),
    excludeBranchId: ObjectIdSchema.optional(),
    privileges: z.array(UserPrivilegeSchema.exclude(['admin'])).optional().default(['manager', 'staff']),
    secondPrivileges: z.array(secondUserPrivilegeSchema).optional(),
    search: z.string().trim().optional(),
    skip: z.number().int().min(0).optional().default(0),
    limit: z.number().int().positive().max(500).optional(),
}).refine(value => !(value.branchId && value.excludeBranchId), {
    message: 'branchId and excludeBranchId cannot be used together',
});
