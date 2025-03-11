import mongoose, {Document} from 'mongoose';
import {IUser} from './User';

export interface ITask extends Document {
    lead: mongoose.Types.ObjectId;
    due: Date;
    timestamp: Date;
    assigned: mongoose.Types.ObjectId;
}

const TaskSchema = new mongoose.Schema(
    {
        lead: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Lead',
            required: [true, 'lead is required'],
        },
        assigned: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'lead is required'],
        },
        due: {
            type: Date,
            required: true,
        },
        timestamp: {
            type: Date,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

const Task = mongoose.model<ITask>('Task', TaskSchema);

export default Task;