import mongoose, {Document} from 'mongoose';

export type TargetScope = 'legacy' | 'branch' | 'allocation';

export interface ITarget extends Document {
    //represent which in which year, day and time doesn't matter.
    month: Date;
    assigned?: mongoose.Types.ObjectId;
    branch?: mongoose.Types.ObjectId;
    parentTarget?: mongoose.Types.ObjectId;
    scope: TargetScope;
    total: number;
    achieved: number;
}

const TargetSchema = new mongoose.Schema(
    {
        assigned: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
        },
        parentTarget: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Target',
        },
        scope: {
            type: String,
            enum: ['legacy', 'branch', 'allocation'],
            default: 'legacy',
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

TargetSchema.index({ scope: 1, branch: 1, month: 1 });
TargetSchema.index({ scope: 1, branch: 1, assigned: 1, month: 1 });
TargetSchema.index({ assigned: 1, month: 1 });

const Target = mongoose.model<ITarget>('Target', TargetSchema);

export default Target;
