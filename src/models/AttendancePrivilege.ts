import mongoose, { Document, Types } from 'mongoose';

export interface IAttendancePrivilege extends Document {
    _id: Types.ObjectId;
    name: string;
    description?: string;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export interface IEmployeeAttendancePrivilege extends Document {
    _id: Types.ObjectId;
    employee: Types.ObjectId;
    privilegeIds: Types.ObjectId[];
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const AttendancePrivilegeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            unique: true,
        },
        description: {
            type: String,
            trim: true,
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

const EmployeeAttendancePrivilegeSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
        },
        privilegeIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AttendancePrivilege',
        }],
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

AttendancePrivilegeSchema.index({ isActive: 1, name: 1 });
EmployeeAttendancePrivilegeSchema.index({ privilegeIds: 1 });

export const EmployeeAttendancePrivilege = mongoose.model<IEmployeeAttendancePrivilege>(
    'EmployeeAttendancePrivilege',
    EmployeeAttendancePrivilegeSchema
);

const AttendancePrivilege = mongoose.model<IAttendancePrivilege>('AttendancePrivilege', AttendancePrivilegeSchema);

export default AttendancePrivilege;
