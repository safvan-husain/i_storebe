import mongoose, {Document} from 'mongoose';

export interface ICustomer extends Document {
    phone: string;
    name: string;
    email?: string;
    address: string;
    dob?: Date;
    createdAt: Date;
}

const customerSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
            required: [true, 'Phone number is required'],
            trim: true,
            unique: true
        },
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
        },
        email: {
            type: String,
            trim: true,
            match: [
                /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
                'Please add a valid email',
            ],
            optional: true,
        },
        address: {
            type: String,
            required: [true, 'Address is required'],
        },
        dob: {
            type: Date,
            optional: true,
        },
    },
    {
        timestamps: true,
    }
);

customerSchema.index({ phone: 1})
customerSchema.index({ name: 1})

const Customer = mongoose.model<ICustomer>('Customer', customerSchema);

export default Customer;