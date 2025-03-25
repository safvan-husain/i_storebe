import mongoose, {Document, Types} from 'mongoose';
import {z} from "zod";

export const leaveStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type LeaveStatus = z.infer<typeof leaveStatusSchema>;

export interface ILeave<P = Types.ObjectId> extends Document {
    _id: Types.ObjectId;
    date: Date;
    requester: P;
    reason: string;
    status: LeaveStatus
}

const leaveSchema = new mongoose.Schema(
    {
        requester: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        }, reason: {
            type: String,
            required: true,
        },
        date: {
            type: Date,
            required: true,
        },
        status: {
            type: String,
            default: 'pending'
        }
    },
    {
        timestamps: true,
    }
);

const Leave = mongoose.model<ILeave>('Leave', leaveSchema);

export default Leave;