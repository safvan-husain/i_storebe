import { Request, Response } from 'express';
import { z } from 'zod';
import CustomReportModel, { AnyQuestion } from '../../models/CustomReport';
import ReportResponseModel from '../../models/ReportResponse';
import { onCatchError, AppError } from '../../middleware/error';
import { createReportSchema, publishVersionSchema, submitResponseSchema, AnyQuestionInput, listResponsesSchema } from './validation';
import { Types } from 'mongoose';
import User from '../../models/User';

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

export const listResponses = async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id;
    if (!Types.ObjectId.isValid(reportId)) throw new AppError('Invalid report id', 400);
    const filters = listResponsesSchema.parse(req.body ?? {});

    const query: any = { reportId: new Types.ObjectId(reportId) };
    if (filters.respondentId) query.respondentId = new Types.ObjectId(filters.respondentId);
    if (filters.startDate || filters.endDate) {
      query.submittedAt = {} as any;
      if (filters.startDate) (query.submittedAt as any).$gte = filters.startDate;
      if (filters.endDate) (query.submittedAt as any).$lte = filters.endDate;
    }

    const docs = await ReportResponseModel.find(query)
      .sort({ submittedAt: -1 })
      .skip(filters.skip)
      .limit(filters.limit)
      .lean();

    const userIds = Array.from(new Set(docs.map(d => String(d.respondentId))))
      .map(id => new Types.ObjectId(id));
    const users = await User.find({ _id: { $in: userIds } }, { _id: 1, username: 1 }).lean();
    const nameMap = new Map(users.map(u => [String(u._id), u.username]));

    const items = docs.map(d => ({
      id: String(d._id),
      version: d.version,
      respondentId: String(d.respondentId),
      respondentName: nameMap.get(String(d.respondentId)) ?? null,
      submittedAt: d.submittedAt,
      answersCount: d.answers?.length ?? 0,
    }));

    res.status(200).json({ total: items.length, items });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const viewResponse = async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id;
    const responseId = req.params.responseId;
    if (!Types.ObjectId.isValid(reportId) || !Types.ObjectId.isValid(responseId)) {
      throw new AppError('Invalid id', 400);
    }
    const response = await ReportResponseModel.findOne({ _id: responseId, reportId }).lean();
    if (!response) throw new AppError('Response not found', 404);

    const report = await CustomReportModel.findById(reportId).lean();
    if (!report) throw new AppError('Report not found', 404);
    const version = (report.versions ?? []).find(v => v.version === response.version);
    if (!version) throw new AppError('Report version not found', 404);

    const qMap = new Map<string, any>();
    for (const q of (version.questions as any[])) qMap.set(String(q.questionId), q);

    const user = await User.findById(response.respondentId, { username: 1 }).lean();

    const items = (response.answers ?? []).map((a: any) => {
      const q = qMap.get(String(a.questionId));
      if (!q) return null;
      if (q.kind === 'textField') {
        return { questionId: String(q.questionId), kind: q.kind, query: q.query, required: q.required, answer: a.textValue };
      }
      if (q.kind === 'numberField') {
        return { questionId: String(q.questionId), kind: q.kind, query: q.query, required: q.required, answer: a.numberValue };
      }
      if (q.kind === 'choice' || q.kind === 'choiceMultiSelect') {
        const selected = new Set((a.choiceValue?.optionIds ?? []).map((id: any) => String(id)));
        const options = (q.options ?? []).filter((opt: any) => selected.has(String(opt._id)))
          .map((opt: any) => ({ optionId: String(opt._id), label: opt.label, value: opt.value }));
        const other: any = {};
        if (a.choiceValue?.otherText !== undefined) other.otherText = a.choiceValue.otherText;
        if (a.choiceValue?.otherNumber !== undefined) other.otherNumber = a.choiceValue.otherNumber;
        return { questionId: String(q.questionId), kind: q.kind, query: q.query, required: q.required, answer: { options, ...other } };
      }
      return null;
    }).filter(Boolean);

    res.status(200).json({
      id: String(response._id),
      reportId: String(response.reportId),
      version: response.version,
      respondentId: String(response.respondentId),
      respondentName: user?.username ?? null,
      submittedAt: response.submittedAt,
      items,
    });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const listLatestReportsForUser = async (req: Request, res: Response) => {
  try {
    const isAdmin = req.privilege === 'admin';
    const query: any = { status: 'published', 'versions.0': { $exists: true } };
    if (!isAdmin) {
      // Strict match: both privilege and SecondPrivileage must match requester
      query.prvilege = req.privilege;
      query.SecondPrivileage = req.secondPrivilege;
    }

    const docs = await CustomReportModel.find(query).lean();
    const items = docs.map((d: any) => {
      const versions = d.versions ?? [];
      if (versions.length === 0) return null;
      const latest = versions.reduce((acc: any, v: any) => (v.version > acc.version ? v : acc), versions[0]);
      return {
        id: String(d._id),
        title: d.title,
        description: d.description,
        prvilege: d.prvilege,
        SecondPrivileage: d.SecondPrivileage,
        interval: d.interval ?? null,
        status: d.status,
        version: latest.version,
        questions: latest.questions,
        publishedAt: latest.publishedAt,
      };
    }).filter(Boolean);

    res.status(200).json(items);
  } catch (e) {
    onCatchError(e, res);
  }
};
