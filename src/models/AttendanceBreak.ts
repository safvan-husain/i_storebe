import mongoose, { Document, Types } from 'mongoose';

export interface IAttendanceBreakType extends Document {
    _id: Types.ObjectId;
    name: string;
    privilegeIds: Types.ObjectId[];
    maxMinutesPerDay?: number;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export interface IAttendanceBreakSubtype extends Document {
    _id: Types.ObjectId;
    parentBreak: Types.ObjectId;
    name: string;
    privilegeIds: Types.ObjectId[];
    inheritsParentPrivilege: boolean;
    windowStart?: string;
    windowEnd?: string;
    maxMinutesPerEvent?: number;
    maxEventsPerDay?: number;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const AttendanceBreakTypeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            unique: true,
        },
        privilegeIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendancePrivilege',
        }],
        maxMinutesPerDay: {
            type: Number,
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

const AttendanceBreakSubtypeSchema = new mongoose.Schema(
    {
        parentBreak: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakType',
            required: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        privilegeIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendancePrivilege',
        }],
        inheritsParentPrivilege: {
            type: Boolean,
            default: true,
        },
        windowStart: {
            type: String,
            match: timePattern,
        },
        windowEnd: {
            type: String,
            match: timePattern,
        },
        maxMinutesPerEvent: {
            type: Number,
            min: 0,
        },
        maxEventsPerDay: {
            type: Number,
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

AttendanceBreakTypeSchema.index({ isActive: 1, name: 1 });
AttendanceBreakSubtypeSchema.index({ parentBreak: 1, name: 1 }, { unique: true });
AttendanceBreakSubtypeSchema.index({ isActive: 1, parentBreak: 1 });

export const AttendanceBreakSubtype = mongoose.model<IAttendanceBreakSubtype>(
    'AttendanceBreakSubtype',
    AttendanceBreakSubtypeSchema
);

const AttendanceBreakType = mongoose.model<IAttendanceBreakType>('AttendanceBreakType', AttendanceBreakTypeSchema);

export default AttendanceBreakType;
