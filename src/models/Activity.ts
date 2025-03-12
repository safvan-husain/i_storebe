import mongoose, {Document, Schema, Types} from 'mongoose';
import {ActivityType} from "../controllers/activity/validation";



export interface IActivity extends Document {
    activator: Types.ObjectId;
    lead: Types.ObjectId;
    action: string;
    type: ActivityType;
    optionalMessage?: string;
    task?: Types.ObjectId,
    createdAt: Date;
}

const activitySchema = new Schema<IActivity>(
    {
        activator: {type: Schema.Types.ObjectId, ref: 'User', required: true},
        lead: {type: Schema.Types.ObjectId, ref: 'Lead', required: true},
        task: {type: Schema.Types.ObjectId, ref: 'Task'},
        action: {type: String, required: true},
        optionalMessage: {type: String, required: false},
        type: {type: String, required: true }
    },
    {
        timestamps: true,
    }
);

const Activity = mongoose.model<IActivity>('Activity', activitySchema);

export default Activity;


