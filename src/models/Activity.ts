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

// Pre-save hook to set the action based on type
activitySchema.pre('save', async function(next) {
    try {
        // Only run this if action is not already set
        if (!this.action) {
            // Fetch the user's name from the User collection
            const User = mongoose.model('User');
            const user = await User.findById(this.activator);
            const activatorName = user ? user.name : 'Someone';

            // Set action based on type
            switch (this.type) {
                case 'lead_added':
                    this.action = `${activatorName} created a new lead`;
                    break;
                case 'task_added':
                    this.action = `${activatorName} added a task`;
                    break;
                case 'task_updated':
                    this.action = `${activatorName} updated a task`;
                    break;
                case 'lead_updated':
                    this.action = `${activatorName} updated lead information`;
                    break;
                case 'note_added':
                    this.action = `${activatorName} added a note`;
                    break;
                case 'followup_added':
                    this.action = `${activatorName} added a followup`;
                    break;
                case 'status_updated':
                    this.action = `${activatorName} updated status`;
                    break;
                case 'purpose_updated':
                    this.action = `${activatorName} updated purpose`;
                    break;
                case 'check_in':
                    this.action = `${activatorName} checked in`;
                    break;
                case 'check_out':
                    this.action = `${activatorName} checked out`;
                    break;
                default:
                    this.action = `${activatorName} performed an action`;
            }
        }
        next();
    } catch (error) {
        next(error as any);
    }
});

const Activity = mongoose.model<IActivity>('Activity', activitySchema);

export default Activity;


