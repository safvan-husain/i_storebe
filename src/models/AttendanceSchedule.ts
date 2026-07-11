import mongoose, { Document, Types } from 'mongoose';

export type AttendanceScheduleAssignmentTargetType = 'global' | 'branch' | 'group' | 'employee';

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
    branch?: Types.ObjectId;
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
    group?: Types.ObjectId;
    employee?: Types.ObjectId;
    effectiveFrom: Date;
    expiresAt?: Date;
    supersededAt?: Date;
    isActive: boolean;
    configurationStatus?: 'upcoming';
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export interface IAttendanceScheduleGroup extends Document {
    _id: Types.ObjectId;
    name: string;
    description?: string;
    branch?: Types.ObjectId;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export interface IAttendanceScheduleGroupMembership extends Document {
    _id: Types.ObjectId;
    group: Types.ObjectId;
    employee: Types.ObjectId;
    effectiveFrom: Date;
    effectiveTo?: Date;
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
        },
        type: {
            type: String,
            enum: ['weekly'],
            default: 'weekly',
            required: true,
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
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
        configurationStatus: {
            type: String,
            enum: ['upcoming'],
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
    const targetType = (this as unknown as IAttendanceScheduleAssignment).targetType;
    const branch = (this as unknown as IAttendanceScheduleAssignment).branch;
    const group = (this as unknown as IAttendanceScheduleAssignment).group;
    const employee = (this as unknown as IAttendanceScheduleAssignment).employee;

    if (targetType === 'branch' && !branch) {
        this.invalidate('branch', 'Branch is required for branch schedule assignments.');
    }

    if (targetType === 'global' && branch) {
        this.invalidate('branch', 'Branch must be empty for global schedule assignments.');
    }

    if (targetType === 'group' && !group) {
        this.invalidate('group', 'Group is required for group schedule assignments.');
    }

    if (targetType !== 'group' && group) {
        this.invalidate('group', 'Group is allowed only for group schedule assignments.');
    }

    if (targetType === 'employee' && !employee) {
        this.invalidate('employee', 'Employee is required for employee schedule assignments.');
    }

    if (targetType !== 'employee' && employee) {
        this.invalidate('employee', 'Employee is allowed only for employee schedule assignments.');
    }

    next();
});

const AttendanceScheduleGroupSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
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

const AttendanceScheduleGroupMembershipSchema = new mongoose.Schema(
    {
        group: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceScheduleGroup',
            required: true,
        },
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        effectiveFrom: {
            type: Date,
            required: true,
        },
        effectiveTo: {
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

AttendanceScheduleTemplateSchema.index({ branch: 1, name: 1 }, { unique: true });
AttendanceScheduleTemplateSchema.index({ isActive: 1, branch: 1, name: 1 });
AttendanceScheduleAssignmentSchema.index({ targetType: 1, branch: 1, effectiveFrom: -1 });
AttendanceScheduleAssignmentSchema.index({ targetType: 1, group: 1, effectiveFrom: -1 });
AttendanceScheduleAssignmentSchema.index({ targetType: 1, employee: 1, effectiveFrom: -1 });
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
AttendanceScheduleAssignmentSchema.index(
    { targetType: 1, group: 1 },
    {
        unique: true,
        partialFilterExpression: {
            targetType: 'group',
            isActive: true,
            supersededAt: { $exists: false },
        },
    }
);
AttendanceScheduleAssignmentSchema.index(
    { targetType: 1, employee: 1 },
    {
        unique: true,
        partialFilterExpression: {
            targetType: 'employee',
            isActive: true,
            supersededAt: { $exists: false },
        },
    }
);
AttendanceScheduleGroupSchema.index({ branch: 1, name: 1 }, { unique: true });
AttendanceScheduleGroupSchema.index({ isActive: 1, branch: 1, name: 1 });
AttendanceScheduleGroupMembershipSchema.index({ group: 1, employee: 1, effectiveFrom: -1 });
AttendanceScheduleGroupMembershipSchema.index({ employee: 1, isActive: 1, effectiveFrom: -1, effectiveTo: 1 });

export const AttendanceScheduleAssignment = mongoose.model<IAttendanceScheduleAssignment>(
    'AttendanceScheduleAssignment',
    AttendanceScheduleAssignmentSchema
);

export const AttendanceScheduleGroup = mongoose.model<IAttendanceScheduleGroup>(
    'AttendanceScheduleGroup',
    AttendanceScheduleGroupSchema
);

export const AttendanceScheduleGroupMembership = mongoose.model<IAttendanceScheduleGroupMembership>(
    'AttendanceScheduleGroupMembership',
    AttendanceScheduleGroupMembershipSchema
);

const AttendanceScheduleTemplate = mongoose.model<IAttendanceScheduleTemplate>(
    'AttendanceScheduleTemplate',
    AttendanceScheduleTemplateSchema
);

export default AttendanceScheduleTemplate;
