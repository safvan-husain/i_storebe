import mongoose, {Document, Schema, Types} from 'mongoose';

export interface IActivity extends Document {
    activator: Types.ObjectId;
    lead: Types.ObjectId;
    action: string;
    optionalMessage?: string;
    task?: Types.ObjectId,
    timestamp: Date;
}

const activitySchema = new Schema<IActivity>(
    {
        activator: {type: Schema.Types.ObjectId, ref: 'User', required: true},
        lead: {type: Schema.Types.ObjectId, ref: 'Lead', required: true},
        task: {type: Schema.Types.ObjectId, ref: 'Task', required: true},
        action: {type: String, required: true},
        optionalMessage: {type: String, required: false},
        timestamp: {type: Date, required: true},
    },
);

const Activity = mongoose.model<IActivity>('Activity', activitySchema);

export default Activity;


