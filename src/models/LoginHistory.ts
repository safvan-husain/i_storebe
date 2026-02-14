import mongoose, {Document, Types} from 'mongoose';

export interface ILoginHistory extends Document {
    _id: Types.ObjectId;
    userId: Types.ObjectId;
    username: string;
    managerId?: Types.ObjectId;
    managerName?: string;
    loginDate: Date;
    createdAt: Date;
}

const LoginHistorySchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        username: {
            type: String,
            required: true,
        },
        managerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        managerName: {
            type: String,
        },
        loginDate: {
            type: Date,
            required: true,
            default: Date.now,
        },
    },
    {
        timestamps: true,
    }
);

// Index for better query performance
LoginHistorySchema.index({ userId: 1, loginDate: -1 });
LoginHistorySchema.index({ managerId: 1, loginDate: -1 });
LoginHistorySchema.index({ loginDate: -1 });

const LoginHistory = mongoose.model<ILoginHistory>('LoginHistory', LoginHistorySchema);

export default LoginHistory;
