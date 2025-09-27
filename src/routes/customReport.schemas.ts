import { z } from 'zod';
import { QuestionKindSchema, ReportIntervalSchema, ReportStatusSchema } from '../common/types';
import {
  createReportSchema,
  publishVersionSchema,
  submitResponseSchema,
} from '../controllers/custom-report/validation';

export const reportIntervalResponseSchema = z.object({
  type: ReportIntervalSchema,
  times: z.array(z.number().int()).optional(),
});

export const questionShowIfSchema = z.object({
  questionId: z.string(),
  optionIdEquals: z.string().optional(),
  exists: z.boolean().optional(),
});

export const choiceOptionResponseSchema = z.object({
  _id: z.string(),
  label: z.string(),
  value: z.string(),
  description: z.string().optional(),
  index: z.number().int().optional(),
});

const baseQuestionResponseSchema = z.object({
  questionId: z.string(),
  index: z.number().int(),
  query: z.string(),
  kind: QuestionKindSchema,
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  showIf: questionShowIfSchema.optional(),
});

const choiceQuestionResponseSchema = baseQuestionResponseSchema.extend({
  kind: z.literal('choice'),
  options: z.array(choiceOptionResponseSchema),
  allowOther: z.boolean().optional(),
  otherAnswerType: z.enum(['textField', 'numberField']).optional(),
});

const choiceMultiQuestionResponseSchema = baseQuestionResponseSchema.extend({
  kind: z.literal('choiceMultiSelect'),
  options: z.array(choiceOptionResponseSchema),
  allowOther: z.boolean().optional(),
  otherAnswerType: z.enum(['textField', 'numberField']).optional(),
  minSelect: z.number().int().optional(),
  maxSelect: z.number().int().optional(),
});

const textQuestionResponseSchema = baseQuestionResponseSchema.extend({
  kind: z.literal('textField'),
  placeholder: z.string().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
});

const numberQuestionResponseSchema = baseQuestionResponseSchema.extend({
  kind: z.literal('numberField'),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const questionResponseSchema = z.discriminatedUnion('kind', [
  choiceQuestionResponseSchema,
  choiceMultiQuestionResponseSchema,
  textQuestionResponseSchema,
  numberQuestionResponseSchema,
]);

export const latestReportResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional().nullable(),
  prvilege: z.string(),
  SecondPrivileage: z.string().optional().nullable(),
  interval: reportIntervalResponseSchema.nullable(),
  status: ReportStatusSchema,
  version: z.number().int(),
  questions: z.array(questionResponseSchema),
  publishedAt: z.number().int().optional(),
});

export const listCustomReportsResponseSchema = z.array(latestReportResponseSchema);

export const createCustomReportRequestSchema = createReportSchema;

export const createCustomReportResponseSchema = z.object({
  id: z.string(),
});

export const publishCustomReportVersionRequestSchema = publishVersionSchema;

export const publishCustomReportVersionResponseSchema = z.object({
  id: z.string(),
  version: z.number().int(),
});

const responseAnswerOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  value: z.string(),
});

const baseResponseItemSchema = z.object({
  questionId: z.string(),
  query: z.string(),
  required: z.boolean().optional(),
});

const textResponseItemSchema = baseResponseItemSchema.extend({
  kind: z.literal('textField'),
  answer: z.string(),
});

const numberResponseItemSchema = baseResponseItemSchema.extend({
  kind: z.literal('numberField'),
  answer: z.number(),
});

const choiceAnswerSchema = z.object({
  options: z.array(responseAnswerOptionSchema),
  otherText: z.string().optional(),
  otherNumber: z.number().optional(),
});

const choiceResponseItemSchema = baseResponseItemSchema.extend({
  kind: z.literal('choice'),
  answer: choiceAnswerSchema,
});

const choiceMultiResponseItemSchema = baseResponseItemSchema.extend({
  kind: z.literal('choiceMultiSelect'),
  answer: choiceAnswerSchema,
});

export const submitCustomReportResponseRequestSchema = submitResponseSchema;

export const submitCustomReportResponseResponseSchema = z.object({
  id: z.string(),
});

export const viewCustomReportResponseResponseSchema = z.object({
  id: z.string(),
  reportId: z.string(),
  version: z.number().int(),
  respondentId: z.string(),
  respondentName: z.string().nullable(),
  submittedAt: z.number().int().optional(),
  items: z.array(
    z.discriminatedUnion('kind', [
      textResponseItemSchema,
      numberResponseItemSchema,
      choiceResponseItemSchema,
      choiceMultiResponseItemSchema,
    ]),
  ),
});

export type QuestionShowIfResponse = z.infer<typeof questionShowIfSchema>;
export type ChoiceOptionResponse = z.infer<typeof choiceOptionResponseSchema>;
export type CustomReportQuestionResponse = z.infer<typeof questionResponseSchema>;
export type LatestCustomReportResponse = z.infer<typeof latestReportResponseSchema>;
export type ListCustomReportsResponse = z.infer<typeof listCustomReportsResponseSchema>;
export type CreateCustomReportRequest = z.infer<typeof createCustomReportRequestSchema>;
export type CreateCustomReportResponse = z.infer<typeof createCustomReportResponseSchema>;
export type PublishCustomReportVersionRequest = z.infer<typeof publishCustomReportVersionRequestSchema>;
export type PublishCustomReportVersionResponse = z.infer<typeof publishCustomReportVersionResponseSchema>;
export type SubmitCustomReportResponseRequest = z.infer<typeof submitCustomReportResponseRequestSchema>;
export type SubmitCustomReportResponseResponse = z.infer<typeof submitCustomReportResponseResponseSchema>;
export type ViewCustomReportResponseResponse = z.infer<typeof viewCustomReportResponseResponseSchema>;
