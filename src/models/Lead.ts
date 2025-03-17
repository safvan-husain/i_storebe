import mongoose, {Document, ObjectId} from 'mongoose';
import {CallStatus, EnquireSourceType, EnquireStatusType, PurposeType} from "../controllers/leads/validations";

export interface ILead extends Document {
    source: EnquireSourceType;
    enquireStatus: EnquireStatusType;
    purpose: PurposeType;
    callStatus: CallStatus;
    manager: mongoose.Types.ObjectId;
    type: string;
    customer: ObjectId,
    product: string;
    createdAt: Date;
}

const LeadSchema = new mongoose.Schema(
    {
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
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Manager is required'],
        },
        customer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Customer',
            required: [true, 'Customer is required'],
        },
    },
    {
        timestamps: true,
    }
);

const Lead = mongoose.model<ILead>('Lead', LeadSchema);

export default Lead;
