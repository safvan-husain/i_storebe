import mongoose, { Document, Types } from 'mongoose';

export type AttendanceDayOverrideTargetType = 'global' | 'branch' | 'group' | 'employee';
export type AttendanceDayOverrideType = 'hours' | 'off_day';

export interface IAttendanceDayOverride extends Document {
    _id: Types.ObjectId;
    targetType: AttendanceDayOverrideTargetType;
    branch?: Types.ObjectId;
    group?: Types.ObjectId;
    employee?: Types.ObjectId;
    date: string;
    overrideType: AttendanceDayOverrideType;
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

const AttendanceDayOverrideSchema = new mongoose.Schema(
    {
        targetType: {
            type: String,
            enum: ['global', 'branch', 'group', 'employee'],
            required: true,
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
        },
        group: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceScheduleGroup',
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

AttendanceDayOverrideSchema.pre('validate', function (next) {
    const targetType = (this as unknown as IAttendanceDayOverride).targetType;
    const branch = (this as unknown as IAttendanceDayOverride).branch;
    const group = (this as unknown as IAttendanceDayOverride).group;
    const employee = (this as unknown as IAttendanceDayOverride).employee;

    if (targetType === 'branch' && !branch) {
        this.invalidate('branch', 'Branch is required for branch day overrides.');
    }
    if (targetType !== 'branch' && branch) {
        this.invalidate('branch', 'Branch is allowed only for branch day overrides.');
    }
    if (targetType === 'group' && !group) {
        this.invalidate('group', 'Group is required for group day overrides.');
    }
    if (targetType !== 'group' && group) {
        this.invalidate('group', 'Group is allowed only for group day overrides.');
    }
    if (targetType === 'employee' && !employee) {
        this.invalidate('employee', 'Employee is required for employee day overrides.');
    }
    if (targetType !== 'employee' && employee) {
        this.invalidate('employee', 'Employee is allowed only for employee day overrides.');
    }
    if (targetType === 'global' && (branch || group || employee)) {
        this.invalidate('targetType', 'Global day overrides cannot have branch, group, or employee targets.');
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

AttendanceDayOverrideSchema.index({ date: 1, targetType: 1, isActive: 1, supersededAt: 1 });
AttendanceDayOverrideSchema.index({ date: 1, branch: 1, isActive: 1 });
AttendanceDayOverrideSchema.index({ date: 1, group: 1, isActive: 1 });
AttendanceDayOverrideSchema.index({ date: 1, employee: 1, isActive: 1 });

const AttendanceDayOverride = mongoose.model<IAttendanceDayOverride>(
    'AttendanceDayOverride',
    AttendanceDayOverrideSchema
);

export default AttendanceDayOverride;
