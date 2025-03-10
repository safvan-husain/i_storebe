import mongoose, {Document, Types} from 'mongoose';
import bcrypt from 'bcryptjs';
import {UserPrivilege} from '../enums/enums';


export interface IUser extends Document {
    name: string;
    phone: string;
    password: string;
    privilege: UserPrivilege;
    //if the user is staff, they should have a manager
    manager?: Types.ObjectId;

    comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },
        phone: {
            type: String,
            required: [true, 'Phone number is required'],
            trim: true,
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

const User = mongoose.model<IUser>('User', UserSchema);

export default User;
