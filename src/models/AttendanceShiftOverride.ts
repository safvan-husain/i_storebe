import mongoose, { Document, Types } from 'mongoose';

export type AttendanceShiftOverrideTargetType = 'shift' | 'employee';
export type AttendanceShiftOverrideType = 'hours' | 'off_day';

export interface IAttendanceShiftOverride extends Document {
    _id: Types.ObjectId;
    targetType: AttendanceShiftOverrideTargetType;
    branch: Types.ObjectId;
    shift?: Types.ObjectId;
    employee?: Types.ObjectId;
    date: string;
    overrideType: AttendanceShiftOverrideType;
    startTime?: string;
    endTime?: string;
    requiredWorkMinutes: number;
    note?: string;
    version: number;
    isActive: boolean;
    createdBy: Types.ObjectId;
    supersededAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const AttendanceShiftOverrideSchema = new mongoose.Schema(
    {
        targetType: {
            type: String,
            enum: ['shift', 'employee'],
            required: true,
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
            required: true,
        },
        shift: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceShift',
        },
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        date: {
            type: String,
            required: true,
            match: datePattern,
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
        note: {
            type: String,
            trim: true,
        },
        version: {
            type: Number,
            default: 1,
            min: 1,
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
        supersededAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
    }
);

AttendanceShiftOverrideSchema.pre('validate', function (next) {
    if (this.targetType === 'shift' && !this.shift) {
        this.invalidate('shift', 'Shift is required for shift overrides.');
    }
    if (this.targetType === 'shift' && this.employee) {
        this.invalidate('employee', 'Employee must be empty for shift overrides.');
    }
    if (this.targetType === 'employee' && !this.employee) {
        this.invalidate('employee', 'Employee is required for employee overrides.');
    }
    if (this.targetType === 'employee' && this.shift) {
        this.invalidate('shift', 'Shift must be empty for employee overrides.');
    }
    if (this.overrideType === 'hours' && (!this.startTime || !this.endTime)) {
        this.invalidate('startTime', 'Start and end time are required for hours overrides.');
    }
    if (this.overrideType === 'off_day') {
        this.startTime = undefined;
        this.endTime = undefined;
        this.requiredWorkMinutes = 0;
    }
    next();
});

AttendanceShiftOverrideSchema.index({ branch: 1, date: 1, targetType: 1, shift: 1, isActive: 1 });
AttendanceShiftOverrideSchema.index({ branch: 1, date: 1, targetType: 1, employee: 1, isActive: 1 });

const AttendanceShiftOverride = mongoose.model<IAttendanceShiftOverride>(
    'AttendanceShiftOverride',
    AttendanceShiftOverrideSchema
);

export default AttendanceShiftOverride;
