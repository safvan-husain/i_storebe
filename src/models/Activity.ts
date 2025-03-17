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

interface IActivityModel extends mongoose.Model<IActivity> {
    createActivity(activityData: Partial<IActivity>): Promise<IActivity>;
}

const activitySchema = new Schema<IActivity>(
    {
        activator: {type: Schema.Types.ObjectId, ref: 'User', required: true},
        lead: {type: Schema.Types.ObjectId, ref: 'Lead', required: true},
        task: {type: Schema.Types.ObjectId, ref: 'Task'},
        action: {type: String, required: true},
        optionalMessage: {type: String, required: false},
        type: {type: String, required: true}
    },
    {
        timestamps: true,
    }
);

// Pre-save hook to set the action based on type
activitySchema.statics.createActivity = async function (activityData) {
    console.log("called pre save");
    // Only run activityData if action is not already set
    if (!activityData.action) {
        // Fetch the user's name from the User collection
        const User = mongoose.model('User');
        const user = await User.findById(activityData.activator);
        const activatorName = user ? user.name : 'Someone';

        // Set action based on type
        switch (activityData.type) {
            case 'lead_added':
                activityData.action = `${activatorName} created a new lead`;
                break;
            case 'task_added':
                activityData.action = `${activatorName} added a task`;
                break;
            case 'task_updated':
                activityData.action = `${activatorName} updated a task`;
                break;
            case 'lead_updated':
                activityData.action = `${activatorName} updated lead information`;
                break;
            case 'note_added':
                activityData.action = `${activatorName} added a note`;
                break;
            case 'followup_added':
                activityData.action = `${activatorName} added a followup`;
                break;
            case 'status_updated':
                activityData.action = `${activatorName} updated status`;
                break;
            case 'purpose_updated':
                activityData.action = `${activatorName} updated purpose`;
                break;
            case 'check_in':
                activityData.action = `${activatorName} checked in`;
                break;
            case 'check_out':
                activityData.action = `${activatorName} checked out`;
                break;
            default:
                activityData.action = `${activatorName} performed an action`;
        }

        return await this.create(activityData);
    }
}

const Activity = mongoose.model<IActivity, IActivityModel>('Activity', activitySchema);

export default Activity;


