import mongoose, { Document, Types } from 'mongoose';

export type AttendanceDailyStatus =
    | 'present'
    | 'absent'
    | 'off_day'
    | 'incomplete'
    | 'missing_checkout'
    | 'open_break';

export interface IAttendanceScheduledSegment {
    shift: Types.ObjectId;
    scheduledStart: string;
    scheduledEnd: string;
    requiredWorkMinutes: number;
}

export interface IAttendanceBreakTotal {
    breakType?: Types.ObjectId;
    breakSubtype?: Types.ObjectId;
    minutes: number;
    allowedMinutes: number;
    excessMinutes: number;
    unusedAllowedMinutes: number;
    overtimeMinutes: number;
    undertimeMinutes: number;
}

export interface IAttendanceDailySnapshot extends Document {
    _id: Types.ObjectId;
    employee: Types.ObjectId;
    branch: Types.ObjectId;
    date: string;
    branchTimezone: string;
    scheduleAssignment?: Types.ObjectId;
    scheduleTemplate?: Types.ObjectId;
    shiftIds: Types.ObjectId[];
    scheduledSegments: IAttendanceScheduledSegment[];
    scheduledStart?: string;
    scheduledEnd?: string;
    requiredWorkMinutes: number;
    firstCheckIn?: string;
    lastCheckOut?: string;
    firstCheckInAt?: Date;
    lastCheckOutAt?: Date;
    grossMinutes: number;
    productiveWorkMinutes: number;
    totalBreakMinutes: number;
    breakOvertimeMinutes: number;
    breakUndertimeMinutes: number;
    overtimeMinutes: number;
    undertimeMinutes: number;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    breakTotals: IAttendanceBreakTotal[];
    status: AttendanceDailyStatus;
    generatedFromEventIds: Types.ObjectId[];
    generatedBy: 'checkout' | 'scheduled_job' | 'correction' | 'manual';
    generatedAt: Date;
    version: number;
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const ScheduledSegmentSchema = new mongoose.Schema(
    {
        shift: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceShift',
            required: true,
        },
        scheduledStart: {
            type: String,
            required: true,
            match: timePattern,
        },
        scheduledEnd: {
            type: String,
            required: true,
            match: timePattern,
        },
        requiredWorkMinutes: {
            type: Number,
            required: true,
            min: 0,
        },
    },
    { _id: false }
);

const BreakTotalSchema = new mongoose.Schema(
    {
        breakType: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakType',
        },
        breakSubtype: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakSubtype',
        },
        minutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        allowedMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        excessMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        unusedAllowedMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        overtimeMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        undertimeMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
    },
    { _id: false }
);

const AttendanceDailySnapshotSchema = new mongoose.Schema(
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
        date: {
            type: String,
            required: true,
            match: datePattern,
        },
        branchTimezone: {
            type: String,
            required: true,
            trim: true,
        },
        scheduleAssignment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceScheduleAssignment',
        },
        scheduleTemplate: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceScheduleTemplate',
        },
        shiftIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceShift',
        }],
        scheduledSegments: {
            type: [ScheduledSegmentSchema],
            default: [],
        },
        scheduledStart: {
            type: String,
            match: timePattern,
        },
        scheduledEnd: {
            type: String,
            match: timePattern,
        },
        requiredWorkMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        firstCheckIn: {
            type: String,
            match: timePattern,
        },
        lastCheckOut: {
            type: String,
            match: timePattern,
        },
        firstCheckInAt: {
            type: Date,
        },
        lastCheckOutAt: {
            type: Date,
        },
        grossMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        productiveWorkMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        totalBreakMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        breakOvertimeMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        breakUndertimeMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        overtimeMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        undertimeMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        lateMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        earlyLeaveMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
        breakTotals: {
            type: [BreakTotalSchema],
            default: [],
        },
        status: {
            type: String,
            enum: ['present', 'absent', 'off_day', 'incomplete', 'missing_checkout', 'open_break'],
            required: true,
        },
        generatedFromEventIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceEvent',
        }],
        generatedBy: {
            type: String,
            enum: ['checkout', 'scheduled_job', 'correction', 'manual'],
            required: true,
        },
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
        notes: {
            type: String,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

AttendanceDailySnapshotSchema.index({ employee: 1, date: 1 }, { unique: true });
AttendanceDailySnapshotSchema.index({ branch: 1, date: 1, status: 1 });
AttendanceDailySnapshotSchema.index({ status: 1, date: -1 });

const AttendanceDailySnapshot = mongoose.model<IAttendanceDailySnapshot>(
    'AttendanceDailySnapshot',
    AttendanceDailySnapshotSchema
);

export default AttendanceDailySnapshot;
