import mongoose, { Document, Types } from 'mongoose';

export type AttendanceScheduleAssignmentTargetType = 'global' | 'branch';

export interface IAttendanceWeeklyPattern {
    monday: Types.ObjectId[];
    tuesday: Types.ObjectId[];
    wednesday: Types.ObjectId[];
    thursday: Types.ObjectId[];
    friday: Types.ObjectId[];
    saturday: Types.ObjectId[];
    sunday: Types.ObjectId[];
}

export interface IAttendanceScheduleTemplate extends Document {
    _id: Types.ObjectId;
    name: string;
    type: 'weekly';
    weeklyPattern: IAttendanceWeeklyPattern;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export interface IAttendanceScheduleAssignment extends Document {
    _id: Types.ObjectId;
    template: Types.ObjectId;
    targetType: AttendanceScheduleAssignmentTargetType;
    branch?: Types.ObjectId;
    effectiveFrom: Date;
    expiresAt?: Date;
    supersededAt?: Date;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const dayShiftRefs = [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AttendanceShift',
}];

const AttendanceScheduleTemplateSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            unique: true,
        },
        type: {
            type: String,
            enum: ['weekly'],
            default: 'weekly',
            required: true,
        },
        weeklyPattern: {
            monday: dayShiftRefs,
            tuesday: dayShiftRefs,
            wednesday: dayShiftRefs,
            thursday: dayShiftRefs,
            friday: dayShiftRefs,
            saturday: dayShiftRefs,
            sunday: dayShiftRefs,
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

const AttendanceScheduleAssignmentSchema = new mongoose.Schema(
    {
        template: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceScheduleTemplate',
            required: true,
        },
        targetType: {
            type: String,
            enum: ['global', 'branch'],
            required: true,
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
        },
        effectiveFrom: {
            type: Date,
            required: true,
        },
        expiresAt: {
            type: Date,
        },
        supersededAt: {
            type: Date,
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

AttendanceScheduleAssignmentSchema.pre('validate', function (next) {
    if (this.targetType === 'branch' && !this.branch) {
        this.invalidate('branch', 'Branch is required for branch schedule assignments.');
    }

    if (this.targetType === 'global' && this.branch) {
        this.invalidate('branch', 'Branch must be empty for global schedule assignments.');
    }

    next();
});

AttendanceScheduleTemplateSchema.index({ isActive: 1, name: 1 });
AttendanceScheduleAssignmentSchema.index({ targetType: 1, branch: 1, effectiveFrom: -1 });
AttendanceScheduleAssignmentSchema.index({ expiresAt: 1, supersededAt: 1, isActive: 1 });
AttendanceScheduleAssignmentSchema.index(
    { targetType: 1 },
    {
        unique: true,
        partialFilterExpression: {
            targetType: 'global',
            isActive: true,
            supersededAt: { $exists: false },
        },
    }
);
AttendanceScheduleAssignmentSchema.index(
    { targetType: 1, branch: 1 },
    {
        unique: true,
        partialFilterExpression: {
            targetType: 'branch',
            isActive: true,
            supersededAt: { $exists: false },
        },
    }
);

export const AttendanceScheduleAssignment = mongoose.model<IAttendanceScheduleAssignment>(
    'AttendanceScheduleAssignment',
    AttendanceScheduleAssignmentSchema
);

const AttendanceScheduleTemplate = mongoose.model<IAttendanceScheduleTemplate>(
    'AttendanceScheduleTemplate',
    AttendanceScheduleTemplateSchema
);

export default AttendanceScheduleTemplate;
