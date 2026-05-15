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

export interface IAttendanceCalculationBasisSegment {
    shiftId?: Types.ObjectId;
    shiftName?: string;
    shiftVersion?: number;
    scheduledStart: string;
    scheduledEnd: string;
    requiredWorkMinutes: number;
    graceLateMinutes: number;
    graceEarlyLeaveMinutes: number;
}

export interface IAttendanceCalculationBasisDayOverride {
    overrideId: Types.ObjectId;
    targetType: string;
    overrideType: 'hours' | 'off_day';
    startTime?: string;
    endTime?: string;
    requiredWorkMinutes: number;
}

export interface IAttendanceCalculationBasis {
    schemaVersion: number;
    capturedAt: Date;
    source?: 'employee' | 'group' | 'branch' | 'global' | 'shift_membership' | null;
    branchTimezone: string;
    scheduleAssignment?: Types.ObjectId;
    scheduleTemplate?: Types.ObjectId;
    shiftMembership?: Types.ObjectId;
    dayOverride?: IAttendanceCalculationBasisDayOverride;
    scheduledSegments: IAttendanceCalculationBasisSegment[];
    scheduledStart?: string;
    scheduledEnd?: string;
    requiredWorkMinutes: number;
}

export interface IAttendanceBreakSession {
    startEventId: Types.ObjectId;
    endEventId: Types.ObjectId;
    startAt: Date;
    endAt: Date;
    startLocalTime: string;
    endLocalTime: string;
    breakType?: Types.ObjectId;
    breakTypeName?: string;
    breakSubtype?: Types.ObjectId;
    breakSubtypeName?: string;
    maxMinutesPerDay?: number;
    maxMinutesPerEvent?: number;
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
    breakSessions: IAttendanceBreakSession[];
    calculationBasis?: IAttendanceCalculationBasis;
    status: AttendanceDailyStatus;
    generatedFromEventIds: Types.ObjectId[];
    generatedBy: 'event' | 'checkout' | 'scheduled_job' | 'correction' | 'manual';
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

const CalculationBasisSegmentSchema = new mongoose.Schema(
    {
        shiftId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceShift',
        },
        shiftName: {
            type: String,
            trim: true,
        },
        shiftVersion: {
            type: Number,
            min: 1,
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
    },
    { _id: false }
);

const CalculationBasisDayOverrideSchema = new mongoose.Schema(
    {
        overrideId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceDayOverride',
            required: true,
        },
        targetType: {
            type: String,
            required: true,
            trim: true,
        },
        overrideType: {
            type: String,
            enum: ['hours', 'off_day'],
            required: true,
        },
        startTime: {
            type: String,
            match: timePattern,
        },
        endTime: {
            type: String,
            match: timePattern,
        },
        requiredWorkMinutes: {
            type: Number,
            default: 0,
            min: 0,
        },
    },
    { _id: false }
);

const CalculationBasisSchema = new mongoose.Schema(
    {
        schemaVersion: {
            type: Number,
            required: true,
            default: 1,
            min: 1,
        },
        capturedAt: {
            type: Date,
            required: true,
            default: Date.now,
        },
        source: {
            type: String,
            enum: ['employee', 'group', 'branch', 'global', 'shift_membership', null],
            default: null,
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
        shiftMembership: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceShiftMembership',
        },
        dayOverride: {
            type: CalculationBasisDayOverrideSchema,
        },
        scheduledSegments: {
            type: [CalculationBasisSegmentSchema],
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
    },
    { _id: false }
);

const BreakSessionSchema = new mongoose.Schema(
    {
        startEventId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceEvent',
            required: true,
        },
        endEventId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceEvent',
            required: true,
        },
        startAt: {
            type: Date,
            required: true,
        },
        endAt: {
            type: Date,
            required: true,
        },
        startLocalTime: {
            type: String,
            required: true,
            match: timePattern,
        },
        endLocalTime: {
            type: String,
            required: true,
            match: timePattern,
        },
        breakType: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakType',
        },
        breakTypeName: {
            type: String,
            trim: true,
        },
        breakSubtype: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakSubtype',
        },
        breakSubtypeName: {
            type: String,
            trim: true,
        },
        maxMinutesPerDay: {
            type: Number,
            min: 0,
        },
        maxMinutesPerEvent: {
            type: Number,
            min: 0,
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
        breakSessions: {
            type: [BreakSessionSchema],
            default: [],
        },
        calculationBasis: {
            type: CalculationBasisSchema,
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
            enum: ['event', 'checkout', 'scheduled_job', 'correction', 'manual'],
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
