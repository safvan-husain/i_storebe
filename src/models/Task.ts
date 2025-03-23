import mongoose, {Document, Types} from 'mongoose';
import {IUser} from './User';
import {Category} from "../controllers/tasks/validation";

export interface ITask extends Document {
    _id: Types.ObjectId;
    lead: mongoose.Types.ObjectId;
    due: Date;
    // timestamp: Date;
    assigned: mongoose.Types.ObjectId;
    category: Category;
    title?: string;
    description?: string;
    isCompleted: boolean;
    createdAt: Date;
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
        }, title: {
            type: String,
        }, description: {
            type: String,
        },
        category: {
            type: String,
            required: true
        },
        due: {
            type: Date,
            required: true,
        },
        // timestamp: {
        //     type: Date,
        //     required: true,
        // },
        isCompleted: {
            type: Boolean,
            default: false,
        }
    },
    {
        timestamps: true,
    }
);

const Task = mongoose.model<ITask>('Task', TaskSchema);

export default Task;