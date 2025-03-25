import mongoose, {Document, Model, Types} from 'mongoose';
import bcrypt from 'bcryptjs';
import {UserPrivilege, SecondUserPrivilege} from '../common/types';

export interface IUser extends Document {
    _id: Types.ObjectId;
    username: string;
    password: string;
    privilege: UserPrivilege;
    secondPrivilege: SecondUserPrivilege;
    //if the user is staff, they should have a manager
    manager?: Types.ObjectId;
    //TODO: remove this later.
    // token?:  string;
    comparePassword(candidatePassword: string): Promise<boolean>;
    createdAt: Date;
}

interface UserModel extends Model<IUser> {
    username: string;
    token?: string;
    password: string;
    privilege: UserPrivilege;
    secondPrivilege: SecondUserPrivilege;
    manager?: Types.ObjectId;
    phone: string;
}

const UserSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
        },
        username: {
            type: String,
            // required: true,
        },
        token: {
            type: String,
        },
        password: {
            type: String,
            required: [true, 'Password is required'],
            minlength: [6, 'Password must be at least 6 characters long'],
        },
        privilege: {
            type: String,
            enum: ['admin', 'manager', 'staff'],
            default: 'staff',
        },
        secondPrivilege: {
            type: String,
            enum: ['super', 'call-center', 'regular'],
            default: 'regular'
        },
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
    }
);

// Hash password before saving
UserSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Method to compare password
UserSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
    return await bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model<IUser, UserModel>('User', UserSchema);

export default User;
