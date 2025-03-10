import {z} from 'zod';
import {ObjectIdSchema} from "../auth/validation";

export const EnquireSource = z.enum(['call', 'facebook', 'instagram', 'previous customer', 'wabis', 'walkin', 'whatsapp']);
export const Purpose = z.enum(['inquire', 'purchase', 'sales', 'service request']);
export const EnquireStatus = z.enum(['empty', 'contacted', 'interested', 'lost', 'new', 'none', 'pending', 'quotation shared', 'visit store', 'won']);

const LeadStatus = z.object({
    source: EnquireSource,
    enquireStatus: EnquireStatus,
    purpose: Purpose
});

// Lead validation schemas
export const crateLeadSchema = z.object({
    phone: z.string().min(1, {message: 'Phone is required'}),
    name: z.string().min(1, {message: 'Name is required'}),
    email: z.string().email({message: 'Invalid email format'}).optional(),
    product: z.string().min(1, {message: 'Purpose is required'}),
    address: z.string().min(1, {message: 'Address is required'}),
    manager: ObjectIdSchema.optional(),
    dob: z.number().optional().transform(val => val ? new Date(val) : undefined)
}).merge(LeadStatus);

export const updateLeadStatusSchema = LeadStatus.partial();

export const updateLeadData = crateLeadSchema.partial();

export const LeadFilterSchema = z.object({
    startDate: z.string().optional().transform(val => val ? new Date(val) : undefined),
    endDate: z.string().optional().transform(val => val ? new Date(val) : undefined),
    manager: z.string().optional(),
    enquireStatus: z.string().optional(),
    source: z.string().optional(),
    purpose: z.string().optional(),
    phone: z.string().optional(),
    page: z.string().optional().transform(val => val ? parseInt(val) : 1),
    limit: z.string().optional().transform(val => val ? parseInt(val) : 10)
})