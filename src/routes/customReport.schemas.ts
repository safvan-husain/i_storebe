import { z } from 'zod';
import { QuestionKindSchema, ReportIntervalSchema, ReportStatusSchema } from '../common/types';
import { createReportSchema, publishVersionSchema } from '../controllers/custom-report/validation';

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

export type QuestionShowIfResponse = z.infer<typeof questionShowIfSchema>;
export type ChoiceOptionResponse = z.infer<typeof choiceOptionResponseSchema>;
export type CustomReportQuestionResponse = z.infer<typeof questionResponseSchema>;
export type LatestCustomReportResponse = z.infer<typeof latestReportResponseSchema>;
export type ListCustomReportsResponse = z.infer<typeof listCustomReportsResponseSchema>;
export type CreateCustomReportRequest = z.infer<typeof createCustomReportRequestSchema>;
export type CreateCustomReportResponse = z.infer<typeof createCustomReportResponseSchema>;
export type PublishCustomReportVersionRequest = z.infer<typeof publishCustomReportVersionRequestSchema>;
export type PublishCustomReportVersionResponse = z.infer<typeof publishCustomReportVersionResponseSchema>;
