import mongoose, { Schema, Types, Document } from 'mongoose';

export interface ChoiceOption {
  _id: Types.ObjectId;
  label: string;
  value: string;
  description?: string;
  index?: number;
}

export type QuestionKind = 'choice' | 'choiceMultiSelect' | 'textField' | 'numberField'; //TODO: also addd "perStaff"

export interface BaseQuestion {
  questionId: Types.ObjectId;
  index: number;
  query: string;
  kind: QuestionKind;
  helpText?: string;
  required?: boolean;
  // simple conditional logic support
  showIf?: { questionId: Types.ObjectId; optionIdEquals?: Types.ObjectId; exists?: boolean };
}

export interface ChoiceQuestion extends BaseQuestion {
  kind: 'choice';
  options: ChoiceOption[];
  allowOther?: boolean;
  otherAnswerType?: 'textField' | 'numberField';
}

export interface ChoiceMultiQuestion extends BaseQuestion {
  kind: 'choiceMultiSelect';
  options: ChoiceOption[];
  allowOther?: boolean;
  otherAnswerType?: 'textField' | 'numberField';
  minSelect?: number;
  maxSelect?: number;
}

export interface TextQuestion extends BaseQuestion {
  kind: 'textField';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
}

export interface NumberQuestion extends BaseQuestion {
  kind: 'numberField';
  min?: number;
  max?: number;
}

export type AnyQuestion = ChoiceQuestion | ChoiceMultiQuestion | TextQuestion | NumberQuestion;

const ChoiceOptionSchema = new Schema<ChoiceOption>({
  _id: { type: Schema.Types.ObjectId, default: () => new Types.ObjectId() },
  label: { type: String, required: true },
  value: { type: String, required: true },
  description: { type: String },
  index: { type: Number },
}, { _id: false });

const QuestionSchema = new Schema<any>({
  questionId: { type: Schema.Types.ObjectId, default: () => new Types.ObjectId() },
  index: { type: Number, required: true },
  query: { type: String, required: true, trim: true },
  kind: { type: String, required: true, enum: ['choice', 'choiceMultiSelect', 'textField', 'numberField'] },
  helpText: { type: String },
  required: { type: Boolean, default: false },
  showIf: {
    questionId: { type: Schema.Types.ObjectId },
    optionIdEquals: { type: Schema.Types.ObjectId },
    exists: { type: Boolean },
  } as any,

  // choice/common
  options: { type: [ChoiceOptionSchema], default: undefined },
  allowOther: { type: Boolean, default: undefined },
  otherAnswerType: { type: String, enum: ['textField', 'numberField'], default: undefined },

  // multi
  minSelect: { type: Number, default: undefined },
  maxSelect: { type: Number, default: undefined },

  // text
  placeholder: { type: String, default: undefined },
  minLength: { type: Number, default: undefined },
  maxLength: { type: Number, default: undefined },

  // number
  min: { type: Number, default: undefined },
  max: { type: Number, default: undefined },
}, { _id: false });

export interface CustomReportVersion {
  version: number;
  questions: AnyQuestion[];
  publishedAt?: Date;
  locked: boolean;
}

const CustomReportVersionSchema = new Schema<CustomReportVersion>({
  version: { type: Number, required: true },
  questions: { type: [QuestionSchema], required: true },
  publishedAt: { type: Date, default: () => new Date() },
  locked: { type: Boolean, default: true },
}, { _id: false });

export type ReportStatus = 'draft' | 'published' | 'archived';

export interface IntervalConfig {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly';
  times?: Date[];
}

export interface CustomReport extends Document {
  title: string;
  description?: string;
  prvilege: string; // UserPrivilege
  SecondPrivileage?: string; // Second privilege
  interval?: IntervalConfig;
  versions: CustomReportVersion[];
  status: ReportStatus;
}

const IntervalConfigSchema = new Schema<IntervalConfig>({
  type: { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly'], required: true },
  times: { type: [Date], default: [] },
}, { _id: false });

const CustomReportSchema = new Schema<CustomReport>({
  title: { type: String, required: true, trim: true },
  description: { type: String },
  prvilege: { type: String, required: true },
  SecondPrivileage: { type: String },
  interval: { type: IntervalConfigSchema, required: false },
  versions: { type: [CustomReportVersionSchema], default: [] },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
}, { timestamps: true });

CustomReportSchema.index({ status: 1 });

const CustomReportModel = mongoose.model<CustomReport>('CustomReport', CustomReportSchema);
export default CustomReportModel;
