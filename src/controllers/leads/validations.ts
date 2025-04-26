import {z} from 'zod';
import {ObjectIdSchema, paginationSchema, optionalDateQueryFiltersSchema} from "../../common/types";

export const EnquireSource = z.enum(['call', 'facebook', 'instagram', 'previous customer', 'wabis', 'walkin', 'whatsapp', 'call center']);
export const Purpose = z.enum(['inquiry', 'purchase', 'sales', 'service request']);
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

const LeadData = z.object({
    phone: z.string().min(1, {message: 'Phone is required'}),
    name: z.string().min(1, {message: 'Name is required'}),
    email: z.string().email({message: 'Invalid email format'}).optional(),
    product: z.string().min(1, {message: 'Purpose is required'}),
    address: z.string().optional().default(''),
    type: Type,
    manager: ObjectIdSchema.optional(),
    //this would be IST since getting from client
    dob: z.number().optional().transform(val => val ? new Date(val) : undefined),
    nearestStore: z.string().optional()
})

export const updateLeadStatusSchema = z.object({
    transferTo: z.string().optional()
}).merge(LeadStatus.partial()).refine(
    (data) => Object.keys(data).length > 0,
    {
        message: "At least one field must be provided.",
    }
);

export type UpdateLeadStatus = z.infer<typeof updateLeadStatusSchema>

// Lead validation schemas
export const crateLeadSchema = z.object({}).merge(LeadStatus).merge(LeadData);

export type UpdateLeadStatusData = z.infer<typeof updateLeadStatusSchema>;

export const updateLeadData = LeadData.partial().refine(
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
    queryType: z.enum(['regular', 'spotlight']).optional().default('regular')
}).merge(paginationSchema).merge(optionalDateQueryFiltersSchema);

export const inActivateUserRequestSchema = z.object({
    id: ObjectIdSchema,
    isActive: z.boolean()
})

export const changeUserPasswordRequestSchema = z.object({
    id: ObjectIdSchema,
    password: z.string().min(6, {message: 'Password must be at least 6 characters long'})
})

const staffSchema = z.object({
    _id: z.any(), // replace with z.string() or z.instanceof(ObjectId) if using mongoose
    username: z.string(),
    privilege: z.string(),
    secondPrivilege: z.string().optional(), // in case it's nullable or optional
    isActive: z.boolean().default(true),
});

export const managerWithStaffsSchema = z.object({
    _id: z.any(),
    username: z.string(),
    privilege: z.string(),
    secondPrivilege: z.string().optional(),
    isActive: z.boolean().default(true),
    staffs: z.array(staffSchema),
});

export type ManagerWithStaffs = z.infer<typeof managerWithStaffsSchema>;

