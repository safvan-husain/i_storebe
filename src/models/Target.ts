import mongoose, {Document} from 'mongoose';

export interface ITarget extends Document {
    //represent which in which year, day and time doesn't matter.
    month: Date;
    assigned: mongoose.Types.ObjectId;
    total: number;
    achieved: number;
}

const TargetSchema = new mongoose.Schema(
    {
        assigned: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        month: {
            type: Date,
            required: true,
        },
        total: {
            type: Number,
            default: false,
        },
        achieved: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

const Target = mongoose.model<ITarget>('Target', TargetSchema);

export default Target;