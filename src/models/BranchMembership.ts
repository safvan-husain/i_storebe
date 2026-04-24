import mongoose, { Document, Types } from 'mongoose';

export type BranchMembershipRole = 'manager' | 'staff';
export type BranchMembershipEndReason = 'transferred' | 'removed' | 'manager_changed' | 'branch_inactivated';

export interface IBranchMembership extends Document {
    _id: Types.ObjectId;
    branch: Types.ObjectId;
    user: Types.ObjectId;
    role: BranchMembershipRole;
    startedAt: Date;
    endedAt?: Date;
    startedBy?: Types.ObjectId;
    endedBy?: Types.ObjectId;
    endReason?: BranchMembershipEndReason;
    createdAt: Date;
    updatedAt: Date;
}

const BranchMembershipSchema = new mongoose.Schema(
    {
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
            required: true,
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        role: {
            type: String,
            enum: ['manager', 'staff'],
            required: true,
        },
        startedAt: {
            type: Date,
            required: true,
            default: Date.now,
        },
        endedAt: {
            type: Date,
        },
        startedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        endedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        endReason: {
            type: String,
            enum: ['transferred', 'removed', 'manager_changed', 'branch_inactivated'],
        },
    },
    {
        timestamps: true,
    }
);

BranchMembershipSchema.index({ branch: 1, user: 1, endedAt: 1 });
BranchMembershipSchema.index({ user: 1, endedAt: 1 });
BranchMembershipSchema.index({ branch: 1, startedAt: 1, endedAt: 1 });

const BranchMembership = mongoose.model<IBranchMembership>('BranchMembership', BranchMembershipSchema);

export default BranchMembership;
