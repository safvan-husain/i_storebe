import mongoose, {Document, Types} from 'mongoose';
import {z} from "zod";

export const leaveStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export const leaveDayTypeSchema = z.enum(['full', 'half']);

export type LeaveStatus = z.infer<typeof leaveStatusSchema>;
export type LeaveDayType = z.infer<typeof leaveDayTypeSchema>;

export interface ILeaveDay {
    date: Date;
    dayType: LeaveDayType;
}

export interface ILeave<P = Types.ObjectId> extends Document {
    _id: Types.ObjectId;
    date: Date;
    requester: P;
    dates: ILeaveDay[];
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
        dates: {
            type: [{
                date: {type: Date, required: true},
                dayType: {type: String, enum: ['full', 'half'], required: true, default: 'full'}
            }],
            default: [],
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending'
        }
    },
    {
        timestamps: true,
    }
);

leaveSchema.index({ requester: 1, status: 1, date: -1, createdAt: 1, _id: 1 });
leaveSchema.index({ status: 1, date: -1, createdAt: 1, _id: 1 });
leaveSchema.index({ requester: 1, status: 1, "dates.date": 1, createdAt: 1, _id: 1 });
leaveSchema.index({ status: 1, "dates.date": 1, createdAt: 1, _id: 1 });

const Leave = mongoose.model<ILeave>('Leave', leaveSchema);

export default Leave;
