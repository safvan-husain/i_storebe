import {z} from 'zod';
import {ObjectIdSchema, paginationSchema, dateFiltersSchema} from "../../common/types";

export const EnquireSource = z.enum(['call', 'facebook', 'instagram', 'previous customer', 'wabis', 'walkin', 'whatsapp']);
export const Purpose = z.enum(['inquire', 'purchase', 'sales', 'service request']);
export const EnquireStatus = z.enum(['empty', 'contacted', 'interested', 'lost', 'new', 'none', 'pending', 'quotation shared', 'visit store', 'won']);
export const Type = z.enum(['fresh', 'used']);
export const callStatusSchema = z.enum(['not-updated', 'connected', 'busy', 'switched-off', 'call_back-requested', 'follow-up-scheduled', 'not-reachable', 'connected-on-whatsapp']);


export type EnquireStatusType = z.infer<typeof EnquireStatus>;
export type EnquireSourceType = z.infer<typeof EnquireSource>;
export type PurposeType = z.infer<typeof Purpose>;
export type TypeType = z.infer<typeof Type>;
export type CallStatus = z.infer<typeof callStatusSchema>;


const LeadStatus = z.object({
    source: EnquireSource,
    enquireStatus: EnquireStatus,
    purpose: Purpose,
    callStatus: callStatusSchema.optional(),
});

export const updateLeadStatusSchema = LeadStatus.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: "At least one field (source, enquireStatus, or purpose, callStatus) must be provided.",
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
    //this would be IST since getting from client
    dob: z.number().optional().transform(val => val ? new Date(val) : undefined),
    nearestStore: z.string().optional()
}).merge(LeadStatus);

export type UpdateLeadStatusData = z.infer<typeof updateLeadStatusSchema>;

export const updateLeadData = crateLeadSchema.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: "At least one field must be provided.",
    });

export const LeadFilterSchema = z.object({
    enquireStatus: z.array(EnquireStatus).optional(),
    source: z.array(EnquireSource).optional(),
    type: z.array(Type).optional(),
    purpose: z.array(Purpose).optional(),
    phone: z.string().optional(),
    searchTerm: z.string().optional(),
    managers: z.array(ObjectIdSchema).optional(),
    staffs: z.array(ObjectIdSchema).optional(),
}).merge(paginationSchema).merge(dateFiltersSchema);