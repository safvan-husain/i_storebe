import mongoose, {Document, Schema, Types} from 'mongoose';
import {ActivityType} from "../controllers/activity/validation";
import User from './User';
import { getCurrentBranchIdForUser } from '../services/branch-context';


export interface IActivity extends Document {
    _id: Types.ObjectId;
    activator: Types.ObjectId;
    lead?: Types.ObjectId;
    action: string;
    type: ActivityType;
    optionalMessage?: string;
    task?: Types.ObjectId,
    actorBranch?: Types.ObjectId;
    createdAt: Date;
}

interface IActivityModel extends mongoose.Model<IActivity> {
    createActivity(activityData: Partial<IActivity>): Promise<IActivity>;
}

const activitySchema = new Schema<IActivity>(
    {
        activator: {type: Schema.Types.ObjectId, ref: 'User', required: true},
        lead: {type: Schema.Types.ObjectId, ref: 'Lead', required: false},
        task: {type: Schema.Types.ObjectId, ref: 'Task'},
        actorBranch: {type: Schema.Types.ObjectId, ref: 'Branch'},
        action: {type: String, required: true},
        optionalMessage: {type: String, required: false},
        type: {type: String, required: true}
    },
    {
        timestamps: true,
    }
);

activitySchema.pre('validate', async function (next) {
    if (!this.actorBranch && this.activator) {
        const branchId = await getCurrentBranchIdForUser(this.activator);
        if (branchId) this.actorBranch = branchId;
    }
    next();
});

// Pre-save hook to set the action based on type
activitySchema.statics.createActivity = async function (activityData) {
    console.log("called pre save");
    // Only run activityData if action is not already set
    if (!activityData.action) {
        // Fetch the user's name from the User collection
        const user = await User.findById(activityData.activator, { username: true });
        const activatorName = user ? user.username : 'Someone';

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
            case 'made_won':
                activityData.action = `${activatorName} marked the lead as won`;
                break;
            case 'removed_won':
                activityData.action = `${activatorName} removed the won status`;
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
            case 'completed':
                activityData.action = `${activatorName} completed task`;
                break;
            case 'dialed':
                activityData.action = `${activatorName} dialed`;
                break;
            case 'branch_created':
                activityData.action = `${activatorName} created a branch`;
                break;
            case 'branch_updated':
                activityData.action = `${activatorName} updated a branch`;
                break;
            case 'branch_staff_added':
                activityData.action = `${activatorName} added staff to a branch`;
                break;
            case 'branch_staff_removed':
                activityData.action = `${activatorName} removed staff from a branch`;
                break;
            case 'branch_staff_transferred':
                activityData.action = `${activatorName} transferred staff between branches`;
                break;
            case 'branch_location_updated':
                activityData.action = `${activatorName} updated a branch location`;
                break;
            case 'branch_activated':
                activityData.action = `${activatorName} activated a branch`;
                break;
            case 'branch_inactivated':
                activityData.action = `${activatorName} inactivated a branch`;
                break;
            case 'branch_attendance_enabled':
                activityData.action = `${activatorName} enabled branch attendance`;
                break;
            case 'branch_attendance_disabled':
                activityData.action = `${activatorName} disabled branch attendance`;
                break;
            default:
                activityData.action = `${activatorName} performed an action`;
        }
    }
    return await this.create(activityData);
}

const Activity = mongoose.model<IActivity, IActivityModel>('Activity', activitySchema);

export default Activity;

