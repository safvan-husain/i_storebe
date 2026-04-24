import mongoose, {Document, ObjectId, Schema, Types} from 'mongoose';
import {CallStatus, EnquireSourceType, EnquireStatusType, PurposeType} from "../controllers/leads/validations";

export interface ILead<T = Types.ObjectId, S = Types.ObjectId> extends Document {
    _id: Types.ObjectId,
    source: EnquireSourceType;
    enquireStatus: EnquireStatusType;
    purpose: PurposeType;
    callStatus: CallStatus;
    createdBy: mongoose.Types.ObjectId;
    manager: mongoose.Types.ObjectId;
    createdBranch?: mongoose.Types.ObjectId;
    handlingBranch?: mongoose.Types.ObjectId;
    wonBranch?: mongoose.Types.ObjectId;
    wonBy?: mongoose.Types.ObjectId;
    //useful when call center staff transfer the lead.
    isAvailableForAllUnderManager: boolean;
    //when transferring this would be useful.
    //when a manager is the one (handled by) all the staff under him would have access to this.
    handledBy: S;
    type: string;
    customer: T,
    product: string;
    createdAt: Date;
    nearestStore?:string;
    contactSnapshot?: {
        name: string;
        phone: string;
        email?: string;
        address?: string;
        dob?: Date;
    }
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
        createdBranch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
        },
        handlingBranch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
        },
        wonBranch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
        },
        wonBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
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
        },
        contactSnapshot: {
            name: { type: String, required: false },
            phone: { type: String, required: false },
            email: { type: String, required: false },
            address: { type: String, required: false },
            dob: { type: Date, required: false },
        }
    },
    {
        timestamps: true,
    }
);

LeadSchema.index({ manager: 1 });
LeadSchema.index({ handledBy: 1 });
LeadSchema.index({ createdBy: 1 });
LeadSchema.index({ createdBranch: 1 });
LeadSchema.index({ handlingBranch: 1 });
LeadSchema.index({ wonBranch: 1 });

const Lead = mongoose.model<ILead>('Lead', LeadSchema);

export default Lead;
