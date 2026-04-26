import mongoose, { Document, Types } from 'mongoose';

export interface IAttendanceShift extends Document {
    _id: Types.ObjectId;
    name: string;
    startTime: string;
    endTime: string;
    requiredWorkMinutes: number;
    graceLateMinutes: number;
    graceEarlyLeaveMinutes: number;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const AttendanceShiftSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        startTime: {
            type: String,
            required: true,
            match: timePattern,
        },
        endTime: {
            type: String,
            required: true,
            match: timePattern,
        },
        requiredWorkMinutes: {
            type: Number,
            required: true,
            min: 0,
        },
        graceLateMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        graceEarlyLeaveMinutes: {
            type: Number,
            default: 0,
            min: 0,
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

AttendanceShiftSchema.index({ isActive: 1, name: 1 });

const AttendanceShift = mongoose.model<IAttendanceShift>('AttendanceShift', AttendanceShiftSchema);

export default AttendanceShift;
