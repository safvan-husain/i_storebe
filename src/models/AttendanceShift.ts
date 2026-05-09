import mongoose, { Document, Types } from 'mongoose';

export type AttendanceWeekday =
    | 'monday'
    | 'tuesday'
    | 'wednesday'
    | 'thursday'
    | 'friday'
    | 'saturday'
    | 'sunday';

export interface IAttendanceShiftDayRule {
    startTime: string;
    endTime: string;
    requiredWorkMinutes: number;
}

export type IAttendanceShiftWeeklyPattern = Record<AttendanceWeekday, IAttendanceShiftDayRule | null>;

export interface IAttendanceShift extends Document {
    _id: Types.ObjectId;
    name: string;
    startTime: string;
    endTime: string;
    requiredWorkMinutes: number;
    weeklyPattern?: IAttendanceShiftWeeklyPattern;
    version: number;
    previousVersions: Array<{
        version: number;
        name: string;
        startTime: string;
        endTime: string;
        requiredWorkMinutes: number;
        weeklyPattern?: IAttendanceShiftWeeklyPattern;
        graceLateMinutes: number;
        graceEarlyLeaveMinutes: number;
        isActive: boolean;
        savedAt: Date;
    }>;
    graceLateMinutes: number;
    graceEarlyLeaveMinutes: number;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const AttendanceShiftDayRuleSchema = new mongoose.Schema(
    {
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
    },
    { _id: false }
);

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
        weeklyPattern: {
            monday: { type: AttendanceShiftDayRuleSchema, default: null },
            tuesday: { type: AttendanceShiftDayRuleSchema, default: null },
            wednesday: { type: AttendanceShiftDayRuleSchema, default: null },
            thursday: { type: AttendanceShiftDayRuleSchema, default: null },
            friday: { type: AttendanceShiftDayRuleSchema, default: null },
            saturday: { type: AttendanceShiftDayRuleSchema, default: null },
            sunday: { type: AttendanceShiftDayRuleSchema, default: null },
        },
        version: {
            type: Number,
            default: 1,
            min: 1,
        },
        previousVersions: {
            type: [{
                version: Number,
                name: String,
                startTime: String,
                endTime: String,
                requiredWorkMinutes: Number,
                weeklyPattern: {
                    monday: { type: AttendanceShiftDayRuleSchema, default: null },
                    tuesday: { type: AttendanceShiftDayRuleSchema, default: null },
                    wednesday: { type: AttendanceShiftDayRuleSchema, default: null },
                    thursday: { type: AttendanceShiftDayRuleSchema, default: null },
                    friday: { type: AttendanceShiftDayRuleSchema, default: null },
                    saturday: { type: AttendanceShiftDayRuleSchema, default: null },
                    sunday: { type: AttendanceShiftDayRuleSchema, default: null },
                },
                graceLateMinutes: Number,
                graceEarlyLeaveMinutes: Number,
                isActive: Boolean,
                savedAt: Date,
            }],
            default: [],
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
