import mongoose, { Document, Types } from 'mongoose';

export type AttendanceEventType = 'check_in' | 'check_out' | 'break_start' | 'break_end';
export type AttendanceEventSource = 'mobile' | 'admin' | 'system';

export interface IAttendanceEvent extends Document {
    _id: Types.ObjectId;
    employee: Types.ObjectId;
    branch: Types.ObjectId;
    type: AttendanceEventType;
    timestamp: Date;
    branchLocalDate: string;
    branchLocalTime: string;
    branchTimezone: string;
    breakType?: Types.ObjectId;
    breakSubtype?: Types.ObjectId;
    source: AttendanceEventSource;
    createdBy?: Types.ObjectId;
    deviceId?: string;
    location?: {
        latitude: number;
        longitude: number;
        accuracyMeters: number;
        distanceMeters: number;
        allowedRadiusMeters: number;
    };
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const AttendanceEventSchema = new mongoose.Schema(
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
        type: {
            type: String,
            enum: ['check_in', 'check_out', 'break_start', 'break_end'],
            required: true,
        },
        timestamp: {
            type: Date,
            required: true,
            default: Date.now,
        },
        branchLocalDate: {
            type: String,
            required: true,
            match: datePattern,
        },
        branchLocalTime: {
            type: String,
            required: true,
            match: timePattern,
        },
        branchTimezone: {
            type: String,
            required: true,
            trim: true,
        },
        breakType: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakType',
        },
        breakSubtype: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceBreakSubtype',
        },
        source: {
            type: String,
            enum: ['mobile', 'admin', 'system'],
            default: 'mobile',
            required: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        deviceId: {
            type: String,
            trim: true,
        },
        location: {
            latitude: { type: Number },
            longitude: { type: Number },
            accuracyMeters: { type: Number },
            distanceMeters: { type: Number },
            allowedRadiusMeters: { type: Number },
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

AttendanceEventSchema.pre('validate', function (next) {
    const isBreakEvent = this.type === 'break_start' || this.type === 'break_end';

    if (isBreakEvent && !this.breakType) {
        this.invalidate('breakType', 'Break type is required for break events.');
    }

    if (!isBreakEvent && (this.breakType || this.breakSubtype)) {
        this.invalidate('breakType', 'Break fields are only allowed for break events.');
    }

    next();
});

AttendanceEventSchema.index({ employee: 1, branchLocalDate: 1, timestamp: 1 });
AttendanceEventSchema.index({ branch: 1, branchLocalDate: 1, type: 1 });
AttendanceEventSchema.index({ type: 1, timestamp: -1 });

const AttendanceEvent = mongoose.model<IAttendanceEvent>('AttendanceEvent', AttendanceEventSchema);

export default AttendanceEvent;
