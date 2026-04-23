import mongoose, { Document, Types } from 'mongoose';

export interface IBranch extends Document {
    _id: Types.ObjectId;
    name: string;
    normalizedName: string;
    manager?: Types.ObjectId;
    staffs: Types.ObjectId[];
    location?: {
        latitude: number;
        longitude: number;
        updatedAt: Date;
        updatedBy: Types.ObjectId;
    };
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const BranchSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        normalizedName: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        staffs: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        }],
        location: {
            latitude: { type: Number },
            longitude: { type: Number },
            updatedAt: { type: Date },
            updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

BranchSchema.index({ manager: 1 });
BranchSchema.index({ staffs: 1 });

const Branch = mongoose.model<IBranch>('Branch', BranchSchema);

export default Branch;
