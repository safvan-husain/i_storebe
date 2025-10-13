import { Request } from 'express';
import { z } from 'zod';
import CustomReportModel, { AnyQuestion } from '../../models/CustomReport';
import ReportResponseModel from '../../models/ReportResponse';
import { onCatchError, AppError } from '../../middleware/error';
import { createReportSchema, publishVersionSchema, submitResponseSchema, AnyQuestionInput, listResponsesSchema } from './validation';
import { Types } from 'mongoose';
import User from '../../models/User';
import { TypedResponse } from '../../common/interface';
import {
  ChoiceOptionResponse,
  CustomReportQuestionResponse,
  LatestCustomReportResponse,
  ListCustomReportsResponse,
  QuestionShowIfResponse,
  listCustomReportsResponseSchema,
  CreateCustomReportResponse,
  PublishCustomReportVersionResponse,
  SubmitCustomReportResponseResponse,
  ViewCustomReportResponseResponse,
} from '../../routes/customReport.schemas';

function materializeQuestions(input: AnyQuestionInput[]): AnyQuestion[] {
  // First pass: create questions with generated ids and option ids (with option index)
  const materialized = input.map((q) => {
    const base: any = {
      questionId: new Types.ObjectId(),
      index: q.index,
      query: q.query,
      kind: q.kind,
      helpText: q.helpText,
      required: q.required ?? false,
      answerPerStaff: q.answerPerStaff ?? false,
      // showIf will be resolved in second pass using indices
    };

    if (q.kind === 'choice' || q.kind === 'choiceMultiSelect') {
      base.options = q.options.map((o: any, idx: number) => ({ _id: new Types.ObjectId(), label: o.label, value: o.value, description: o.description, index: idx }));
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

    // Keep the original showIf indices for second pass
    if (q.showIf) base._showIfIndices = q.showIf;

    return base as AnyQuestion & { _showIfIndices?: { questionIndex: number; choiceIndexEquals?: number; exists?: boolean } };
  });

  // Build maps
  const questionIndexToId = new Map<number, Types.ObjectId>();
  for (const q of materialized as any[]) {
    questionIndexToId.set(q.index, q.questionId);
  }

  const optionIndexToId = new Map<string, Types.ObjectId>(); // key: `${qIndex}:${choiceIndex}`
  for (const q of materialized as any[]) {
    if (q.kind === 'choice' || q.kind === 'choiceMultiSelect') {
      (q.options ?? []).forEach((opt: any) => {
        optionIndexToId.set(`${q.index}:${opt.index}`, opt._id);
      });
    }
  }

  // Second pass: resolve showIf indices to ids
  for (const q of materialized as any[]) {
    if (q._showIfIndices) {
      const si = q._showIfIndices;
      const qId = questionIndexToId.get(si.questionIndex);
      if (qId) {
        const resolved: any = { questionId: qId, exists: si.exists };
        if (si.choiceIndexEquals !== undefined) {
          const optId = optionIndexToId.get(`${si.questionIndex}:${si.choiceIndexEquals}`);
          if (optId) resolved.optionIdEquals = optId;
        }
        q.showIf = resolved;
      }
      delete q._showIfIndices;
    }
  }

  return materialized as AnyQuestion[];
}

export const createReport = async (
  req: Request,
  res: TypedResponse<CreateCustomReportResponse>,
) => {
  try {
    const payload = createReportSchema.parse(req.body);

    const doc = await CustomReportModel.create({
      title: payload.title,
      description: payload.description,
      prvilege: payload.prvilege,
      SecondPrivileage: payload.SecondPrivileage,
      interval: payload.interval ? { type: payload.interval.type, times: (payload.interval.times ?? []).map((t) => new Date(t)) } : undefined,
      versions: [{ version: 1, questions: payload.questions, publishedAt: new Date(), locked: true }],
      status: 'published',
    });

    res.status(201).json({ id: String(doc._id) });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const getReport = async (req: Request, res: TypedResponse<any>) => {
  try {
    const id = req.params.id;
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid report id', 400);
    }
    const rep: any = await CustomReportModel.findById(id).lean();
    if (!rep) {
      throw new AppError('Report not found', 404);
    }
    // convert Date fields to millis
    const interval = rep.interval ? {
      type: rep.interval.type,
      times: (rep.interval.times ?? []).map((d: Date) => new Date(d).getTime()),
    } : undefined;
    const versions = (rep.versions ?? []).map((v: any) => ({
      ...v,
      publishedAt: v.publishedAt ? new Date(v.publishedAt).getTime() : undefined,
    }));
    res.status(200).json({ ...rep, interval, versions });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const publishVersion = async (
  req: Request,
  res: TypedResponse<PublishCustomReportVersionResponse>,
) => {
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

export const submitResponse = async (
  req: Request,
  res: TypedResponse<SubmitCustomReportResponseResponse>,
) => {
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

    const validateChoiceAnswer = (choiceValue: any, question: any, label?: string) => {
      const prefix = label ? `${label}: ` : '';
      if (!choiceValue) {
        throw new AppError(`${prefix}choiceValue required for choice question`, 400);
      }
      const optionIds = new Set((question.options ?? []).map((o: any) => String(o._id)));
      for (const oid of choiceValue.optionIds) {
        if (!optionIds.has(String(oid))) {
          throw new AppError(`${prefix}Invalid option selected`, 400);
        }
      }
      if (question.kind === 'choice' && choiceValue.optionIds.length !== 1) {
        throw new AppError(`${prefix}Exactly one option must be selected for choice`, 400);
      }
      if (question.kind === 'choiceMultiSelect') {
        const count = choiceValue.optionIds.length;
        if (question.minSelect !== undefined && count < question.minSelect) {
          throw new AppError(`${prefix}Select at least ${question.minSelect} options`, 400);
        }
        if (question.maxSelect !== undefined && count > question.maxSelect) {
          throw new AppError(`${prefix}Select at most ${question.maxSelect} options`, 400);
        }
      }
      if (choiceValue.otherText !== undefined || choiceValue.otherNumber !== undefined) {
        if (!question.allowOther) {
          throw new AppError(`${prefix}Other answer not allowed for this question`, 400);
        }
        if (question.otherAnswerType === 'textField' && choiceValue.otherText === undefined) {
          throw new AppError(`${prefix}otherText required for otherAnswerType=textField`, 400);
        }
        if (question.otherAnswerType === 'numberField' && choiceValue.otherNumber === undefined) {
          throw new AppError(`${prefix}otherNumber required for otherAnswerType=numberField`, 400);
        }
      }
    };

    const validateAnswerForQuestion = (answer: any, question: any, label?: string) => {
      const prefix = label ? `${label}: ` : '';
      if (question.kind === 'textField') {
        if (answer.textValue === undefined || answer.textValue === null) {
          throw new AppError(`${prefix}textValue required for textField question`, 400);
        }
        const len = answer.textValue.length;
        if (question.minLength !== undefined && len < question.minLength) {
          throw new AppError(`${prefix}textValue must be at least ${question.minLength} chars`, 400);
        }
        if (question.maxLength !== undefined && len > question.maxLength) {
          throw new AppError(`${prefix}textValue must be at most ${question.maxLength} chars`, 400);
        }
      } else if (question.kind === 'numberField') {
        if (typeof answer.numberValue !== 'number') {
          throw new AppError(`${prefix}numberValue required for numberField question`, 400);
        }
        if (question.min !== undefined && answer.numberValue < question.min) {
          throw new AppError(`${prefix}numberValue must be >= ${question.min}`, 400);
        }
        if (question.max !== undefined && answer.numberValue > question.max) {
          throw new AppError(`${prefix}numberValue must be <= ${question.max}`, 400);
        }
      } else if (question.kind === 'choice' || question.kind === 'choiceMultiSelect') {
        validateChoiceAnswer(answer.choiceValue, question, label);
      } else {
        throw new AppError('Unsupported question kind', 400);
      }
    };

    // Required questions check
    const requiredQs = (version.questions as any[]).filter(q => q.required);
    for (const rq of requiredQs) {
      const answered = payload.answers.find(a => a.questionId === String(rq.questionId));
      if (!answered) {
        throw new AppError(`Missing answer for required question: ${rq.query}`, 400);
      }
      if (rq.answerPerStaff) {
        if (!answered.perStaffAnswers || answered.perStaffAnswers.length === 0) {
          throw new AppError(`Missing per-staff answers for required question: ${rq.query}`, 400);
        }
      }
    }

    // Per-answer validation
    for (const a of payload.answers) {
      const q = qMap.get(a.questionId);
      if (!q) throw new AppError('Answer references unknown questionId', 400);

      if (q.answerPerStaff) {
        if (!Array.isArray(a.perStaffAnswers) || a.perStaffAnswers.length === 0) {
          throw new AppError('perStaffAnswers required for this question', 400);
        }
        if (a.textValue !== undefined || a.numberValue !== undefined || a.choiceValue !== undefined) {
          throw new AppError('Provide answers inside perStaffAnswers for per-staff questions', 400);
        }
        for (const per of a.perStaffAnswers) {
          const label = `Per-staff answer for staff ${per.staffId}`;
          validateAnswerForQuestion(per, q, label);
        }
      } else {
        if (Array.isArray(a.perStaffAnswers) && a.perStaffAnswers.length > 0) {
          throw new AppError('perStaffAnswers is only allowed when question is configured for per-staff responses', 400);
        }
        validateAnswerForQuestion(a, q);
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
        perStaffAnswers: a.perStaffAnswers
          ? a.perStaffAnswers.map(per => ({
            staffId: new Types.ObjectId(per.staffId),
            textValue: per.textValue,
            numberValue: per.numberValue,
            choiceValue: per.choiceValue
              ? {
                optionIds: per.choiceValue.optionIds.map((id: any) => new Types.ObjectId(id)),
                otherText: per.choiceValue.otherText,
                otherNumber: per.choiceValue.otherNumber,
              }
              : undefined,
          }))
          : undefined,
      })),
    });

    res.status(201).json({ id: String(toSave._id) });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const listResponses = async (req: Request, res: TypedResponse<any>) => {
  try {
    const reportId = req.params.id;
    if (!Types.ObjectId.isValid(reportId)) throw new AppError('Invalid report id', 400);
    const filters = listResponsesSchema.parse(req.body ?? {});

    const query: any = { reportId: new Types.ObjectId(reportId) };
    if (filters.respondentId) query.respondentId = new Types.ObjectId(filters.respondentId);
    if (filters.startDate || filters.endDate) {
      query.submittedAt = {} as any;
      if (filters.startDate) (query.submittedAt as any).$gte = new Date(filters.startDate);
      if (filters.endDate) (query.submittedAt as any).$lte = new Date(filters.endDate);
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
      submittedAt: d.submittedAt ? new Date(d.submittedAt).getTime() : undefined,
      answersCount: d.answers?.length ?? 0,
    }));

    res.status(200).json({ total: items.length, items });
  } catch (e) {
    onCatchError(e, res);
  }
};

export const viewResponse = async (
  req: Request,
  res: TypedResponse<ViewCustomReportResponseResponse>,
) => {
  try {
    const reportId = req.params.id;
    const responseId = req.params.responseId;
    if (!Types.ObjectId.isValid(reportId) || !Types.ObjectId.isValid(responseId)) {
      throw new AppError('Invalid id', 400);
    }
    const response: any = await ReportResponseModel.findOne({ _id: responseId, reportId }).lean();
    if (!response) throw new AppError('Response not found', 404);

    const report = await CustomReportModel.findById(reportId).lean();
    if (!report) throw new AppError('Report not found', 404);
    const version = (report.versions ?? []).find(v => v.version === response.version);
    if (!version) throw new AppError('Report version not found', 404);

    const qMap = new Map<string, any>();
    for (const q of (version.questions as any[])) qMap.set(String(q.questionId), q);

    const user = await User.findById(response.respondentId, { username: 1 }).lean();

    const staffIdSet = new Set<string>();
    for (const ans of response.answers ?? []) {
      for (const per of ans.perStaffAnswers ?? []) {
        if (per?.staffId) {
          staffIdSet.add(String(per.staffId));
        }
      }
    }

    const staffNameMap = new Map<string, string>();
    if (staffIdSet.size > 0) {
      const staffUsers = await User.find(
        { _id: { $in: Array.from(staffIdSet).map(id => new Types.ObjectId(id)) } },
        { _id: 1, username: 1 },
      ).lean();
      for (const staff of staffUsers) {
        staffNameMap.set(String(staff._id), staff.username ?? null);
      }
    }

    const formatChoiceAnswer = (choiceValue: any, question: any) => {
      const selected = new Set((choiceValue?.optionIds ?? []).map((id: any) => String(id)));
      const options = (question.options ?? [])
        .filter((opt: any) => selected.has(String(opt._id)))
        .map((opt: any) => ({ optionId: String(opt._id), label: opt.label, value: opt.value }));
      const other: any = {};
      if (choiceValue?.otherText !== undefined) other.otherText = choiceValue.otherText;
      if (choiceValue?.otherNumber !== undefined) other.otherNumber = choiceValue.otherNumber;
      return { options, ...other };
    };

    const items = (response.answers ?? []).map((a: any) => {
      const q = qMap.get(String(a.questionId));
      if (!q) return null;
      const base = {
        questionId: String(q.questionId),
        kind: q.kind,
        query: q.query,
        required: q.required,
        answerPerStaff: Boolean(q.answerPerStaff),
      };

      if (q.kind === 'textField') {
        if (q.answerPerStaff) {
          const perStaffAnswers = (a.perStaffAnswers ?? []).map((per: any) => ({
            staffId: String(per.staffId),
            staffName: staffNameMap.get(String(per.staffId)) ?? null,
            answer: per.textValue,
          }));
          return { ...base, perStaffAnswers };
        }
        return { ...base, answer: a.textValue };
      }
      if (q.kind === 'numberField') {
        if (q.answerPerStaff) {
          const perStaffAnswers = (a.perStaffAnswers ?? []).map((per: any) => ({
            staffId: String(per.staffId),
            staffName: staffNameMap.get(String(per.staffId)) ?? null,
            answer: per.numberValue,
          }));
          return { ...base, perStaffAnswers };
        }
        return { ...base, answer: a.numberValue };
      }
      if (q.kind === 'choice' || q.kind === 'choiceMultiSelect') {
        if (q.answerPerStaff) {
          const perStaffAnswers = (a.perStaffAnswers ?? []).map((per: any) => ({
            staffId: String(per.staffId),
            staffName: staffNameMap.get(String(per.staffId)) ?? null,
            answer: formatChoiceAnswer(per.choiceValue, q),
          }));
          return { ...base, perStaffAnswers };
        }
        return { ...base, answer: formatChoiceAnswer(a.choiceValue, q) };
      }
      return null;
    }).filter(Boolean);

    res.status(200).json({
      id: String(response._id),
      reportId: String(response.reportId),
      version: response.version,
      respondentId: String(response.respondentId),
      respondentName: user?.username ?? null,
      submittedAt: response.submittedAt ? new Date(response.submittedAt).getTime() : undefined,
      items,
    });
  } catch (e) {
    onCatchError(e, res);
  }
};

function serializeShowIf(showIf: any | undefined): QuestionShowIfResponse | undefined {
  if (!showIf) return undefined;
  const result: QuestionShowIfResponse = {
    questionId: String(showIf.questionId),
  };
  if (showIf.optionIdEquals !== undefined && showIf.optionIdEquals !== null) {
    result.optionIdEquals = String(showIf.optionIdEquals);
  }
  if (showIf.exists !== undefined) {
    result.exists = Boolean(showIf.exists);
  }
  return result;
}

function serializeChoiceOption(option: any): ChoiceOptionResponse {
  return {
    _id: String(option._id),
    label: option.label,
    value: option.value,
    description: option.description ?? undefined,
    index: typeof option.index === 'number' ? option.index : undefined,
  };
}

function serializeQuestion(question: any): CustomReportQuestionResponse {
  const base = {
    questionId: String(question.questionId),
    index: question.index,
    query: question.query,
    helpText: question.helpText ?? undefined,
    required: typeof question.required === 'boolean' ? question.required : undefined,
    answerPerStaff: typeof question.answerPerStaff === 'boolean' ? question.answerPerStaff : undefined,
    showIf: serializeShowIf(question.showIf),
  };

  switch (question.kind) {
    case 'choice':
      return {
        ...base,
        kind: 'choice',
        options: (question.options ?? []).map(serializeChoiceOption),
        allowOther: typeof question.allowOther === 'boolean' ? question.allowOther : undefined,
        otherAnswerType: question.otherAnswerType ?? undefined,
      };
    case 'choiceMultiSelect':
      return {
        ...base,
        kind: 'choiceMultiSelect',
        options: (question.options ?? []).map(serializeChoiceOption),
        allowOther: typeof question.allowOther === 'boolean' ? question.allowOther : undefined,
        otherAnswerType: question.otherAnswerType ?? undefined,
        minSelect: typeof question.minSelect === 'number' ? question.minSelect : undefined,
        maxSelect: typeof question.maxSelect === 'number' ? question.maxSelect : undefined,
      };
    case 'textField':
      return {
        ...base,
        kind: 'textField',
        placeholder: question.placeholder ?? undefined,
        minLength: typeof question.minLength === 'number' ? question.minLength : undefined,
        maxLength: typeof question.maxLength === 'number' ? question.maxLength : undefined,
      };
    case 'numberField':
      return {
        ...base,
        kind: 'numberField',
        min: typeof question.min === 'number' ? question.min : undefined,
        max: typeof question.max === 'number' ? question.max : undefined,
      };
    default:
      throw new AppError(`Unsupported question kind: ${question.kind}`, 500);
  }
}

function serializeLatestReport(doc: any): LatestCustomReportResponse | null {
  const versions = doc.versions ?? [];
  if (versions.length === 0) return null;
  const latest = versions.reduce((acc: any, v: any) => (v.version > acc.version ? v : acc), versions[0]);

  return {
    id: String(doc._id),
    title: doc.title,
    description: doc.description ?? null,
    prvilege: doc.prvilege,
    SecondPrivileage: doc.SecondPrivileage ?? null,
    interval: doc.interval
      ? {
        type: doc.interval.type,
        times: (doc.interval.times ?? []).map((dt: Date) => new Date(dt).getTime()),
      }
      : null,
    status: doc.status,
    version: latest.version,
    questions: (latest.questions ?? []).map(serializeQuestion),
    publishedAt: latest.publishedAt ? new Date(latest.publishedAt).getTime() : undefined,
  };
}

export const listLatestReportsForUser = async (
  req: Request,
  res: TypedResponse<ListCustomReportsResponse>,
) => {
  try {
    const isAdmin = req.privilege === 'admin';
    const query: any = { status: 'published', 'versions.0': { $exists: true } };
    if (!isAdmin) {
      // Strict match: both privilege and SecondPrivileage must match requester
      query.prvilege = req.privilege;
      query.SecondPrivileage = req.secondPrivilege;
    }

    const docs = await CustomReportModel.find(query).lean();
    const items = docs
      .map((doc: any) => serializeLatestReport(doc))
      .filter((item): item is LatestCustomReportResponse => item !== null);

    const payload = listCustomReportsResponseSchema.parse(items);

    res.status(200).json(payload);
  } catch (e) {
    onCatchError(e, res);
  }
};
