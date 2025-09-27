import { z } from 'zod';
import { ObjectIdSchema, ReportIntervalSchema, QuestionKindSchema, optionalDateQueryFiltersSchema, paginationSchema, UserPrivilegeSchema, secondUserPrivilegeSchema } from '../../common/types';

// Base question schema
const baseQuestion = z.object({
  index: z.number().int().min(0),
  query: z.string().min(1),
  kind: QuestionKindSchema,
  helpText: z.string().optional(),
  required: z.boolean().optional().default(false),
  showIf: z.object({
    questionIndex: z.number().int().min(0),
    choiceIndexEquals: z.number().int().min(0).optional(),
    exists: z.boolean().optional(),
  }).optional(),
});

const choiceOption = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
});

const choiceQuestion = baseQuestion.extend({
  kind: z.literal('choice'),
  options: z.array(choiceOption).min(1),
  allowOther: z.boolean().optional(),
  otherAnswerType: z.enum(['textField', 'numberField']).optional(),
});

const choiceMultiQuestionCore = baseQuestion.extend({
  kind: z.literal('choiceMultiSelect'),
  options: z.array(choiceOption).min(1),
  allowOther: z.boolean().optional(),
  otherAnswerType: z.enum(['textField', 'numberField']).optional(),
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(1).optional(),
});

const textQuestionCore = baseQuestion.extend({
  kind: z.literal('textField'),
  placeholder: z.string().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
});

const numberQuestionCore = baseQuestion.extend({
  kind: z.literal('numberField'),
  min: z.number().optional(),
  max: z.number().optional(),
});

const rawAnyQuestion = z.discriminatedUnion('kind', [
  choiceQuestion, choiceMultiQuestionCore, textQuestionCore, numberQuestionCore,
]);

export const anyQuestionSchema = rawAnyQuestion.superRefine((q, ctx) => {
  if (q.kind === 'textField') {
    if (q.minLength !== undefined && q.maxLength !== undefined && q.minLength > q.maxLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'minLength cannot be greater than maxLength', path: ['minLength'] });
    }
  } else if (q.kind === 'numberField') {
    if (q.min !== undefined && q.max !== undefined && q.min > q.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'min cannot be greater than max', path: ['min'] });
    }
  } else if (q.kind === 'choiceMultiSelect') {
    if (q.minSelect !== undefined && q.maxSelect !== undefined && q.minSelect > q.maxSelect) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'minSelect cannot be greater than maxSelect', path: ['minSelect'] });
    }
  }
});

export type AnyQuestionInput = z.infer<typeof anyQuestionSchema>;

export const createReportSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  prvilege: UserPrivilegeSchema,
  SecondPrivileage: secondUserPrivilegeSchema,
  interval: z.object({
    type: ReportIntervalSchema,
    times: z.array(z.number()).optional(),
  }).optional(),
  questions: z.array(anyQuestionSchema),
});

export const publishVersionSchema = z.object({
  questions: z.array(anyQuestionSchema).min(1),
});

// Response submission
export const submitResponseSchema = z.object({
  version: z.number().int().min(0),
  answers: z.array(z.object({
    questionId: ObjectIdSchema,
    textValue: z.string().optional(),
    numberValue: z.number().optional(),
    choiceValue: z.object({
      optionIds: z.array(ObjectIdSchema).min(1),
      otherText: z.string().optional(),
      otherNumber: z.number().optional(),
    }).optional(),
  })).min(1),
});

export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;

export const listResponsesSchema = z.object({
  respondentId: ObjectIdSchema.optional(),
  startDate: z.number().optional(),
  endDate: z.number().optional(),
}).merge(paginationSchema);
