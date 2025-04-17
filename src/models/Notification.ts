import mongoose, {Document} from 'mongoose';

export interface INotification extends Document {
    //represent which in which year, day and time doesn't matter.
    assigned: mongoose.Types.ObjectId;
    lead: mongoose.Types.ObjectId;
    title: string;
    description: string;
}

const notificationSchema = new mongoose.Schema(
    {
        assigned: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        lead: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Lead',
            required: true,
        },
        title: {
            type: String,
            required: true
        },
        description: {
            type: String,
            required: true
        },
    },
    {
        timestamps: true,
    }
);

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
