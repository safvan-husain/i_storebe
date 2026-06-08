import mongoose, { Document, Types } from 'mongoose';

export interface IAttendanceRemoteWorker extends Document {
    _id: Types.ObjectId;
    employee: Types.ObjectId;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const AttendanceRemoteWorkerSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
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

const AttendanceRemoteWorker = mongoose.model<IAttendanceRemoteWorker>(
    'AttendanceRemoteWorker',
    AttendanceRemoteWorkerSchema
);

export default AttendanceRemoteWorker;
