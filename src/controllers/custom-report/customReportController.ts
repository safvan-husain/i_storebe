import { Request, Response } from 'express';
import { z } from 'zod';
import CustomReportModel, { AnyQuestion } from '../../models/CustomReport';
import ReportResponseModel from '../../models/ReportResponse';
import { onCatchError, AppError } from '../../middleware/error';
import { createReportSchema, publishVersionSchema, submitResponseSchema, AnyQuestionInput } from './validation';
import { Types } from 'mongoose';

function materializeQuestions(input: AnyQuestionInput[]): AnyQuestion[] {
  // Generate stable ids for questionId and option ids
  return input.map((q) => {
    const base = {
      questionId: new Types.ObjectId(),
      index: q.index,
      query: q.query,
      kind: q.kind,
      helpText: q.helpText,
      required: q.required ?? false,
      showIf: q.showIf ? {
        questionId: new Types.ObjectId(q.showIf.questionId),
        optionIdEquals: q.showIf.optionIdEquals ? new Types.ObjectId(q.showIf.optionIdEquals) : undefined,
        exists: q.showIf.exists,
      } : undefined,
    } as any;

    if (q.kind === 'choice' || q.kind === 'choiceMultiSelect') {
      base.options = q.options.map((o: any) => ({ _id: new Types.ObjectId(), label: o.label, value: o.value, description: o.description }));
      base.allowOther = q.allowOther;
      base.otherAnswerType = q.otherAnswerType;
    }

    if (q.kind === 'choiceMultiSelect') {
      base.minSelect = q.minSelect;
      base.maxSelect = q.maxSelect;
    }

    if (q.kind === 'textField') {
      base.placeholder = q.placeholder;
      base.minLength = q.minLength;
      base.maxLength = q.maxLength;
    }

    if (q.kind === 'numberField') {
      base.min = q.min;
      base.max = q.max;
    }

    return base as AnyQuestion;
  });
}

export const createReport = async (req: Request, res: Response) => {
  try {
    const payload = createReportSchema.parse(req.body);

    const doc = await CustomReportModel.create({
      title: payload.title,
      description: payload.description,
      prvilege: payload.prvilege,
      SecondPrivileage: payload.SecondPrivileage,
      interval: payload.interval ? { type: payload.interval.type, times: payload.interval.times ?? [] } : undefined,
      versions: [],
      status: 'draft',
    });

    res.status(201).json({ id: String(doc._id) });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const getReport = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid report id', 400);
    }
    const rep = await CustomReportModel.findById(id).lean();
    if (!rep) {
      throw new AppError('Report not found', 404);
    }
    res.status(200).json(rep);
  } catch (e) {
    onCatchError(e, res);
  }
};

export const publishVersion = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid report id', 400);
    }
    const { questions } = publishVersionSchema.parse(req.body);

    const report = await CustomReportModel.findById(id);
    if (!report) {
      throw new AppError('Report not found', 404);
    }

    const nextVersion = (report.versions?.length ?? 0) + 1;
    const materialized = materializeQuestions(questions);

    report.versions.push({ version: nextVersion, questions: materialized, publishedAt: new Date(), locked: true });
    report.status = 'published';
    await report.save();

    res.status(201).json({ id, version: nextVersion });
  } catch (e) {
    onCatchError(e, res);
  }
};

function findVersionOrThrow(report: any, version: number) {
  const v = (report?.versions ?? []).find((x: any) => x.version === version);
  if (!v) {
    throw new AppError('Report version not found', 404);
  }
  return v;
}

export const submitResponse = async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id;
    if (!Types.ObjectId.isValid(reportId)) {
      throw new AppError('Invalid report id', 400);
    }
    const payload = submitResponseSchema.parse(req.body);
    const respondentId = req.userId;

    if (!respondentId) {
      throw new AppError('User not found', 404);
    }

    const report = await CustomReportModel.findById(reportId).lean();
    if (!report) {
      throw new AppError('Report not found', 404);
    }
    const version = findVersionOrThrow(report, payload.version);

    // Build maps for validation
    const qMap = new Map<string, any>();
    for (const q of version.questions as any[]) {
      qMap.set(String(q.questionId), q);
    }

    // Required questions check
    const requiredQs = (version.questions as any[]).filter(q => q.required);
    for (const rq of requiredQs) {
      const answered = payload.answers.find(a => a.questionId === String(rq.questionId));
      if (!answered) {
        throw new AppError(`Missing answer for required question: ${rq.query}`, 400);
      }
    }

    // Per-answer validation
    for (const a of payload.answers) {
      const q = qMap.get(a.questionId);
      if (!q) throw new AppError('Answer references unknown questionId', 400);

      if (q.kind === 'textField') {
        if (a.textValue === undefined || a.textValue === null) {
          throw new AppError('textValue required for textField question', 400);
        }
        const len = a.textValue.length;
        if (q.minLength !== undefined && len < q.minLength) {
          throw new AppError(`textValue must be at least ${q.minLength} chars`, 400);
        }
        if (q.maxLength !== undefined && len > q.maxLength) {
          throw new AppError(`textValue must be at most ${q.maxLength} chars`, 400);
        }
      } else if (q.kind === 'numberField') {
        if (typeof a.numberValue !== 'number') {
          throw new AppError('numberValue required for numberField question', 400);
        }
        if (q.min !== undefined && a.numberValue < q.min) {
          throw new AppError(`numberValue must be >= ${q.min}`, 400);
        }
        if (q.max !== undefined && a.numberValue > q.max) {
          throw new AppError(`numberValue must be <= ${q.max}`, 400);
        }
      } else if (q.kind === 'choice' || q.kind === 'choiceMultiSelect') {
        if (!a.choiceValue) {
          throw new AppError('choiceValue required for choice question', 400);
        }
        const optionIds = new Set((q.options ?? []).map((o: any) => String(o._id)));
        for (const oid of a.choiceValue.optionIds) {
          if (!optionIds.has(String(oid))) {
            throw new AppError('Invalid option selected', 400);
          }
        }
        if (q.kind === 'choice' && a.choiceValue.optionIds.length !== 1) {
          throw new AppError('Exactly one option must be selected for choice', 400);
        }
        if (q.kind === 'choiceMultiSelect') {
          const c = a.choiceValue.optionIds.length;
          if (q.minSelect !== undefined && c < q.minSelect) {
            throw new AppError(`Select at least ${q.minSelect} options`, 400);
          }
          if (q.maxSelect !== undefined && c > q.maxSelect) {
            throw new AppError(`Select at most ${q.maxSelect} options`, 400);
          }
        }
        if (a.choiceValue.otherText !== undefined || a.choiceValue.otherNumber !== undefined) {
          if (!q.allowOther) {
            throw new AppError('Other answer not allowed for this question', 400);
          }
          if (q.otherAnswerType === 'textField' && a.choiceValue.otherText === undefined) {
            throw new AppError('otherText required for otherAnswerType=textField', 400);
          }
          if (q.otherAnswerType === 'numberField' && a.choiceValue.otherNumber === undefined) {
            throw new AppError('otherNumber required for otherAnswerType=numberField', 400);
          }
        }
      } else {
        throw new AppError('Unsupported question kind', 400);
      }
    }

    const toSave = await ReportResponseModel.create({
      reportId: new Types.ObjectId(reportId),
      version: payload.version,
      respondentId: new Types.ObjectId(respondentId),
      answers: payload.answers.map(a => ({
        questionId: new Types.ObjectId(a.questionId),
        textValue: a.textValue,
        numberValue: a.numberValue,
        choiceValue: a.choiceValue ? {
          optionIds: a.choiceValue.optionIds.map(id => new Types.ObjectId(id)),
          otherText: a.choiceValue.otherText,
          otherNumber: a.choiceValue.otherNumber,
        } : undefined,
      })),
    });

    res.status(201).json({ id: String(toSave._id) });
  } catch (e) {
    onCatchError(e, res);
  }
};
