import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import connectDb from '../config/db';
import CustomReportModel from '../models/CustomReport';

require('dotenv').config();

interface RawChoiceOption {
  _id?: string;
  label: string;
  value: string;
  description?: string;
}

type RawQuestion = {
  questionId?: string;
  options?: RawChoiceOption[];
  [key: string]: unknown;
};

interface RawReport {
  id?: string;
  title: string;
  description?: string | null;
  prvilege: string;
  SecondPrivileage?: string | null;
  interval?: {
    type: 'daily' | 'weekly' | 'monthly' | 'yearly';
    times?: (number | string)[];
  } | null;
  status?: 'draft' | 'published' | 'archived';
  version: number;
  questions: RawQuestion[];
  publishedAt?: number | string;
}

const dataPath = path.join(__dirname, '../../data/custom-reports.json');

function readRawReports(): RawReport[] {
  const buffer = fs.readFileSync(dataPath, 'utf-8');
  return JSON.parse(buffer) as RawReport[];
}

function sanitizeQuestion(question: RawQuestion) {
  const { questionId, options, ...rest } = question;
  const normalized: any = { ...rest };

  if (options && options.length > 0) {
    normalized.options = options.map(({ _id, ...optionRest }) => optionRest);
  }

  if (!('questionId' in normalized)) {
    normalized.questionId = undefined;
  }

  return normalized;
}

function buildReportPayload(rawReport: RawReport) {
  const interval = rawReport.interval
    ? {
        type: rawReport.interval.type,
        times: (rawReport.interval.times ?? []).map((time) => new Date(time)),
      }
    : undefined;

  const questions = rawReport.questions.map(sanitizeQuestion);

  const publishedAt = rawReport.publishedAt ? new Date(rawReport.publishedAt) : new Date();

  return {
    title: rawReport.title,
    description: rawReport.description ?? undefined,
    prvilege: rawReport.prvilege,
    SecondPrivileage: rawReport.SecondPrivileage ?? undefined,
    interval,
    versions: [
      {
        version: rawReport.version ?? 1,
        questions,
        publishedAt,
        locked: true,
      },
    ],
    status: rawReport.status ?? 'published',
  };
}

async function seedCustomReports() {
  await connectDb();

  const rawReports = readRawReports();
  const payloads = rawReports.map(buildReportPayload);

  for (const payload of payloads) {
    await CustomReportModel.findOneAndUpdate(
      { title: payload.title },
      payload,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  console.log(`Seeded ${payloads.length} custom reports.`);

  await mongoose.disconnect();
  process.exit(0);
}

seedCustomReports().catch((error) => {
  console.error('Failed to seed custom reports:', error);
  mongoose.disconnect().finally(() => process.exit(1));
});
