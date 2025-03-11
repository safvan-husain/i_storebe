import {z} from 'zod';
import {ObjectIdSchema} from "../auth/validation";

export const EnquireSource = z.enum(['call', 'facebook', 'instagram', 'previous customer', 'wabis', 'walkin', 'whatsapp']);
export const Purpose = z.enum(['inquire', 'purchase', 'sales', 'service request']);
export const EnquireStatus = z.enum(['empty', 'contacted', 'interested', 'lost', 'new', 'none', 'pending', 'quotation shared', 'visit store', 'won']);
export const Type = z.enum(['fresh', 'new']);


export type EnquireStatusType = z.infer<typeof EnquireStatus>;
export type EnquireSourceType = z.infer<typeof EnquireSource>;
export type PurposeType = z.infer<typeof Purpose>;
export type TypeType = z.infer<typeof Type>;


const LeadStatus = z.object({
    source: EnquireSource,
    enquireStatus: EnquireStatus,
    purpose: Purpose
});

export const updateLeadStatusSchema = LeadStatus.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: "At least one field (source, enquireStatus, or purpose) must be provided.",
    }
);

// Lead validation schemas
export const crateLeadSchema = z.object({
    phone: z.string().min(1, {message: 'Phone is required'}),
    name: z.string().min(1, {message: 'Name is required'}),
    email: z.string().email({message: 'Invalid email format'}).optional(),
    product: z.string().min(1, {message: 'Purpose is required'}),
    address: z.string().min(1, {message: 'Address is required'}),
    type: Type,
    manager: ObjectIdSchema.optional(),
    dob: z.number().optional().transform(val => val ? new Date(val) : undefined)
}).merge(LeadStatus);

export type UpdateLeadStatusData = z.infer<typeof updateLeadStatusSchema>;

export const updateLeadData = crateLeadSchema.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: "At least one field must be provided.",
    });

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

export const LeadFilterSchema = z.object({
    startDate: ISToUTCFromStringSchema,
    endDate: ISToUTCFromStringSchema,
    manager: ObjectIdSchema.optional(),
    enquireStatus: EnquireStatus.optional(),
    source: EnquireSource.optional(),
    type: Type.optional(),
    purpose: z.string().optional(),
    phone: z.string().optional(),
    skip: z.string().optional().transform(val => val ? parseInt(val) : 0),
    limit: z.string().optional().transform(val => val ? parseInt(val) : 20)
})