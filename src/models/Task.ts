import mongoose, { Document } from 'mongoose';
import { IUser } from './User';

export interface ITask extends Document {
  phone: string;
  name: string;
  email?: string;
  source: string;
  enquireStatus: string;
  purpose: string;
  address: string;
  manager: mongoose.Types.ObjectId;
  dob?: Date;
  product: string;
}

const TaskSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
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
    source: {
      type: String,
      required: [true, 'Source is required'],
    },
    enquireStatus: {
      type: String,
      required: [true, 'Enquire status is required'],
    },
    purpose: {
      type: String,
      required: [true, 'Purpose is required'],
    },
    product: {
      type: String,
      required: [true, 'Product is required'],
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
    },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Manager is required'],
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

const Task = mongoose.model<ITask>('Lead', TaskSchema);

export default Task;