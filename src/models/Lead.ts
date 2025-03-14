import mongoose, {Document} from 'mongoose';
import {CallStatus, EnquireSourceType, EnquireStatusType, PurposeType} from "../controllers/leads/validations";

export interface ILead extends Document {
    phone: string;
    name: string;
    email?: string;
    source: EnquireSourceType;
    enquireStatus: EnquireStatusType;
    purpose: PurposeType;
    callStatus: CallStatus;
    address: string;
    manager: mongoose.Types.ObjectId;
    type: string;
    dob?: Date;
    product: string;
    createdAt: Date;
}

const LeadSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
            required: [true, 'Phone number is required'],
            trim: true,
        },
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
        },
        email: {
            type: String,
            trim: true,
            match: [
                /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
                'Please add a valid email',
            ],
            optional: true,
        },
        source: {
            type: String,
            required: [true, 'Source is required'],
        },
        enquireStatus: {
            type: String,
            required: [true, 'Enquire status is required'],
        },
        purpose: {
            type: String,
            required: [true, 'Purpose is required'],
        },
        type: {
            type: String,
            required: [true, 'type is required'],
        },
        callStatus: {
            type: String,
            default: "not-updated"
        },
        product: {
            type: String,
            required: [true, 'Product is required'],
        },
        address: {
            type: String,
            required: [true, 'Address is required'],
        },
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Manager is required'],
        },
        dob: {
            type: Date,
            optional: true,
        },
    },
    {
        timestamps: true,
    }
);

const Lead = mongoose.model<ILead>('Lead', LeadSchema);

export default Lead;
