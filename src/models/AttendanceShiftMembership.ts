import mongoose, { Document, Types } from 'mongoose';

export type AttendanceShiftMembershipStatus = 'active' | 'inactive';

export interface IAttendanceShiftMembership extends Document {
    _id: Types.ObjectId;
    shift: Types.ObjectId;
    employee: Types.ObjectId;
    branch: Types.ObjectId;
    version: number;
    status: AttendanceShiftMembershipStatus;
    activeFrom: Date;
    inactiveFrom?: Date;
    createdBy: Types.ObjectId;
    endedBy?: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const AttendanceShiftMembershipSchema = new mongoose.Schema(
    {
        shift: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendanceShift',
            required: true,
        },
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
        version: {
            type: Number,
            default: 1,
            min: 1,
        },
        status: {
            type: String,
            enum: ['active', 'inactive'],
            default: 'active',
            required: true,
        },
        activeFrom: {
            type: Date,
            required: true,
        },
        inactiveFrom: {
            type: Date,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        endedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
    }
);

AttendanceShiftMembershipSchema.index({ shift: 1, status: 1, activeFrom: -1 });
AttendanceShiftMembershipSchema.index({ employee: 1, branch: 1, status: 1, activeFrom: -1 });
AttendanceShiftMembershipSchema.index({ branch: 1, status: 1 });

const AttendanceShiftMembership = mongoose.model<IAttendanceShiftMembership>(
    'AttendanceShiftMembership',
    AttendanceShiftMembershipSchema
);

export default AttendanceShiftMembership;
