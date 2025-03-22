import mongoose, {Document, ObjectId} from 'mongoose';
import {CallStatus, EnquireSourceType, EnquireStatusType, PurposeType} from "../controllers/leads/validations";

export interface ILead extends Document {
    source: EnquireSourceType;
    enquireStatus: EnquireStatusType;
    purpose: PurposeType;
    callStatus: CallStatus;
    createdBy: mongoose.Types.ObjectId;
    manager: mongoose.Types.ObjectId;
    //useful when call center staff transfer the lead.
    isAvailableForAllUnderManager: boolean;
    //when transferring this would be useful.
    handledBy: ObjectId;
    type: string;
    customer: ObjectId,
    product: string;
    createdAt: Date;
    nearestStore?:string;
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
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        handledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        isAvailableForAllUnderManager: {
          type: Boolean,
          default: false,
        },
        customer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Customer',
            required: [true, 'Customer is required'],
        },
        nearestStore: {
            type: String
        }
    },
    {
        timestamps: true,
    }
);

const Lead = mongoose.model<ILead>('Lead', LeadSchema);

export default Lead;
