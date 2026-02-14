import mongoose, { Schema, Types, Document } from 'mongoose';

export interface ChoiceAnswerValue {
  optionIds: Types.ObjectId[];
  otherText?: string;
  otherNumber?: number;
}

export interface PerStaffAnswer {
  staffId: Types.ObjectId;
  textValue?: string;
  numberValue?: number;
  choiceValue?: ChoiceAnswerValue;
}

export interface AnswerItem {
  questionId: Types.ObjectId;
  textValue?: string;
  numberValue?: number;
  choiceValue?: ChoiceAnswerValue;
  perStaffAnswers?: PerStaffAnswer[];
}

export interface ReportResponse extends Document {
  reportId: Types.ObjectId;
  version: number;
  respondentId: Types.ObjectId;
  answers: AnswerItem[];
  submittedAt?: Date;
}

const ChoiceAnswerValueSchema = new Schema<ChoiceAnswerValue>({
  optionIds: { type: [Schema.Types.ObjectId], default: [] },
  otherText: { type: String },
  otherNumber: { type: Number },
}, { _id: false });

const PerStaffAnswerSchema = new Schema<PerStaffAnswer>({
  staffId: { type: Schema.Types.ObjectId, required: true },
  textValue: { type: String },
  numberValue: { type: Number },
  choiceValue: { type: ChoiceAnswerValueSchema },
}, { _id: false });

const AnswerItemSchema = new Schema<AnswerItem>({
  questionId: { type: Schema.Types.ObjectId, required: true },
  textValue: { type: String },
  numberValue: { type: Number },
  choiceValue: { type: ChoiceAnswerValueSchema },
  perStaffAnswers: { type: [PerStaffAnswerSchema], default: undefined },
}, { _id: false });

const ReportResponseSchema = new Schema<ReportResponse>({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  version: { type: Number, required: true },
  respondentId: { type: Schema.Types.ObjectId, required: true },
  answers: { type: [AnswerItemSchema], required: true },
  submittedAt: { type: Date, default: () => new Date() },
}, { timestamps: true });

ReportResponseSchema.index({ reportId: 1, version: 1, respondentId: 1, submittedAt: -1 });

const ReportResponseModel = mongoose.model<ReportResponse>('ReportResponse', ReportResponseSchema);
export default ReportResponseModel;

