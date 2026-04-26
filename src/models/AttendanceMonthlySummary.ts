import mongoose, { Document, Types } from 'mongoose';

export interface IAttendanceMonthlySummary extends Document {
    _id: Types.ObjectId;
    employee: Types.ObjectId;
    branch: Types.ObjectId;
    month: string;
    branchTimezone: string;
    scheduledDays: number;
    presentDays: number;
    absentDays: number;
    offDays: number;
    incompleteDays: number;
    requiredWorkMinutes: number;
    productiveWorkMinutes: number;
    grossMinutes: number;
    totalBreakMinutes: number;
    breakOvertimeMinutes: number;
    breakUndertimeMinutes: number;
    overtimeMinutes: number;
    undertimeMinutes: number;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    generatedFromSnapshotIds: Types.ObjectId[];
    generatedAt: Date;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

const monthPattern = /^\d{4}-\d{2}$/;

const AttendanceMonthlySummarySchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
            required: true,
        },
        month: {
            type: String,
            required: true,
            match: monthPattern,
        },
        branchTimezone: {
            type: String,
            required: true,
            trim: true,
        },
        scheduledDays: { type: Number, default: 0, min: 0 },
        presentDays: { type: Number, default: 0, min: 0 },
        absentDays: { type: Number, default: 0, min: 0 },
        offDays: { type: Number, default: 0, min: 0 },
        incompleteDays: { type: Number, default: 0, min: 0 },
        requiredWorkMinutes: { type: Number, default: 0, min: 0 },
        productiveWorkMinutes: { type: Number, default: 0, min: 0 },
        grossMinutes: { type: Number, default: 0, min: 0 },
        totalBreakMinutes: { type: Number, default: 0, min: 0 },
        breakOvertimeMinutes: { type: Number, default: 0, min: 0 },
        breakUndertimeMinutes: { type: Number, default: 0, min: 0 },
        overtimeMinutes: { type: Number, default: 0, min: 0 },
        undertimeMinutes: { type: Number, default: 0, min: 0 },
        lateMinutes: { type: Number, default: 0, min: 0 },
        earlyLeaveMinutes: { type: Number, default: 0, min: 0 },
        generatedFromSnapshotIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceDailySnapshot',
        }],
        generatedAt: {
            type: Date,
            required: true,
            default: Date.now,
        },
        version: {
            type: Number,
            default: 1,
            min: 1,
        },
    },
    {
        timestamps: true,
    }
);

AttendanceMonthlySummarySchema.index({ employee: 1, month: 1 }, { unique: true });
AttendanceMonthlySummarySchema.index({ branch: 1, month: 1 });

const AttendanceMonthlySummary = mongoose.model<IAttendanceMonthlySummary>(
    'AttendanceMonthlySummary',
    AttendanceMonthlySummarySchema
);

export default AttendanceMonthlySummary;
