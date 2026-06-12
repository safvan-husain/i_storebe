import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose, { FilterQuery, Types } from 'mongoose';
import connectDb from '../config/db';
import Activity, { IActivity } from '../models/Activity';
import Branch, { IBranch } from '../models/Branch';
import BranchMembership from '../models/BranchMembership';
import Lead, { ILead } from '../models/Lead';
import Task, { ITask } from '../models/Task';
import User, { IUser } from '../models/User';

type Args = {
  start: Date;
  end: Date;
  branch?: string;
  manager?: string;
  includeAllBranches: boolean;
  out?: string;
};

type UserDoc = Pick<IUser, '_id' | 'username' | 'privilege' | 'manager' | 'isActive' | 'isAccountDeleted'>;

type RowMetrics = {
  task_added: number;
  lead_added: number;
  overdue_tasks: number;
  status_updated: number;
  is_won: number;
  is_visited: number;
  pending_tasks: number;
};

type CandidateRow = {
  userId: string;
  username: string;
  privilege: string;
  isActive: boolean;
  isAccountDeleted: boolean;
  includedBecause: string[];
  membershipStatus: string;
  currentRosterRole: string | null;
  currentReportMetrics: RowMetrics;
  metricsIgnoringActiveUserFilter: RowMetrics;
  wouldRenderAsZeroRowToday: boolean;
  hasHiddenCountsBecauseInactive: boolean;
};

const usage = () => {
  console.log(`
Usage:
  npm run snapshot:activity-report -- --start YYYY-MM-DD --end YYYY-MM-DD [--branch <id-or-name>]
  npm run snapshot:activity-report -- --date YYYY-MM-DD [--manager <id-or-username>]
  npm run snapshot:activity-report -- --start YYYY-MM-DD --end YYYY-MM-DD --all-branches [--out /custom/path.json]

Notes:
  - Dates are interpreted as Asia/Kolkata calendar days.
  - This script is read-only. It always writes JSON to logs/activity-report-snapshots/ unless --out is passed.
  - PM2 stdout only gets a short summary; use the written file for the full snapshot.
`);
};

const defaultSnapshotDir = () =>
  path.join(process.env.LOG_DIR ?? path.join(process.cwd(), 'logs'), 'activity-report-snapshots');

const formatDateSlug = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value ?? '0000';
  const month = parts.find(part => part.type === 'month')?.value ?? '00';
  const day = parts.find(part => part.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
};

const defaultSnapshotPath = (start: Date, end: Date) => {
  const startSlug = formatDateSlug(start);
  const endSlug = formatDateSlug(end);
  const rangeSlug = startSlug === endSlug ? startSlug : `${startSlug}_to_${endSlug}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(defaultSnapshotDir(), `activity-report-${rangeSlug}-${timestamp}.json`);
};

const parseDateOnly = (value: string, endOfDay: boolean) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  const [, year, month, day] = match;
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
  return new Date(`${year}-${month}-${day}T${time}+05:30`);
};

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  const getValue = (name: string) => {
    const index = raw.indexOf(name);
    if (index === -1) return undefined;
    const value = raw[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return value;
  };

  if (raw.includes('--help') || raw.includes('-h')) {
    usage();
    process.exit(0);
  }

  const date = getValue('--date');
  const start = getValue('--start') ?? date;
  const end = getValue('--end') ?? date;
  if (!start || !end) {
    usage();
    throw new Error('Pass either --date or both --start and --end.');
  }

  const branch = getValue('--branch');
  const manager = getValue('--manager');
  const includeAllBranches = raw.includes('--all-branches');
  if ([Boolean(branch), Boolean(manager), includeAllBranches].filter(Boolean).length > 1) {
    throw new Error('Pass only one of --branch, --manager, or --all-branches.');
  }

  return {
    start: parseDateOnly(start, false),
    end: parseDateOnly(end, true),
    branch,
    manager,
    includeAllBranches,
    out: getValue('--out'),
  };
};

const objectIdOrUndefined = (value?: string) =>
  value && Types.ObjectId.isValid(value) ? Types.ObjectId.createFromHexString(value) : undefined;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const resolveBranches = async (args: Args) => {
  if (args.includeAllBranches || (!args.branch && !args.manager)) {
    return Branch.find({ isActive: true }, { name: true, manager: true, staffs: true, isActive: true })
      .sort({ name: 1 })
      .lean<IBranch[]>();
  }

  if (args.branch) {
    const branchId = objectIdOrUndefined(args.branch);
    const query: FilterQuery<IBranch> = branchId
      ? { _id: branchId }
      : { name: new RegExp(`^${escapeRegex(args.branch)}$`, 'i') };
    const branch = await Branch.findOne(query, { name: true, manager: true, staffs: true, isActive: true }).lean<IBranch>();
    if (!branch) throw new Error(`Branch not found: ${args.branch}`);
    return [branch];
  }

  const managerId = objectIdOrUndefined(args.manager);
  const managerQuery: FilterQuery<IUser> = managerId
    ? { _id: managerId }
    : { username: new RegExp(`^${escapeRegex(args.manager!)}$`, 'i') };
  const manager = await User.findOne(managerQuery, { _id: true, username: true }).lean<UserDoc>();
  if (!manager) throw new Error(`Manager not found: ${args.manager}`);

  const directBranch = await Branch.findOne(
    { manager: manager._id, isActive: true },
    { name: true, manager: true, staffs: true, isActive: true },
  ).lean<IBranch>();
  if (directBranch) return [directBranch];

  const membership = await BranchMembership.findOne({
    user: manager._id,
    role: 'manager',
    endedAt: { $exists: false },
  }, { branch: true }).lean();
  if (!membership?.branch) throw new Error(`No active branch found for manager: ${manager.username}`);

  const membershipBranch = await Branch.findOne(
    { _id: membership.branch, isActive: true },
    { name: true, manager: true, staffs: true, isActive: true },
  ).lean<IBranch>();
  if (!membershipBranch) throw new Error(`Manager branch is inactive or missing: ${manager.username}`);
  return [membershipBranch];
};

const emptyMetrics = (): RowMetrics => ({
  task_added: 0,
  lead_added: 0,
  overdue_tasks: 0,
  status_updated: 0,
  is_won: 0,
  is_visited: 0,
  pending_tasks: 0,
});

const isZeroMetrics = (metrics: RowMetrics) => Object.values(metrics).every(value => value === 0);

const addMetric = (target: RowMetrics, key: keyof RowMetrics, value = 1) => {
  target[key] += value;
};

const buildMetrics = async (
  branchId: Types.ObjectId,
  candidateIds: Types.ObjectId[],
  start: Date,
  end: Date,
  ignoreActiveUserFilter: boolean,
) => {
  const metricsByUser = new Map<string, RowMetrics>();
  const ensureMetrics = (userId: string) => {
    if (!metricsByUser.has(userId)) metricsByUser.set(userId, emptyMetrics());
    return metricsByUser.get(userId)!;
  };

  const activeUserIds = ignoreActiveUserFilter
    ? new Set(candidateIds.map(String))
    : new Set((await User.find({
      _id: { $in: candidateIds },
      isActive: true,
    }, { _id: true }).lean()).map(user => String(user._id)));

  const allowedUserIds = candidateIds
    .map(String)
    .filter(userId => activeUserIds.has(userId));
  const allowedObjectIds = allowedUserIds.map(id => Types.ObjectId.createFromHexString(id));

  const activityQuery: FilterQuery<IActivity> = {
    actorBranch: branchId,
    activator: { $in: allowedObjectIds },
    createdAt: { $gte: start, $lte: end },
  };
  const activities = await Activity.find(activityQuery, { activator: true, type: true }).lean<IActivity[]>();
  for (const activity of activities) {
    const metrics = ensureMetrics(String(activity.activator));
    if (activity.type === 'task_added' || activity.type === 'followup_added') addMetric(metrics, 'task_added');
    if (activity.type === 'lead_added') addMetric(metrics, 'lead_added');
    if (activity.type === 'status_updated') addMetric(metrics, 'status_updated');
    if (activity.type === 'made_won') addMetric(metrics, 'is_won');
    if (activity.type === 'removed_won') addMetric(metrics, 'is_won', -1);
  }

  const leadQuery: FilterQuery<ILead> = {
    createdAt: { $gte: start, $lte: end },
    createdBy: { $in: candidateIds },
    handledBy: { $in: allowedObjectIds },
    handlingBranch: branchId,
  };
  const leads = await Lead.find(leadQuery, { handledBy: true, enquireStatus: true }).lean<ILead[]>();
  for (const lead of leads) {
    const metrics = ensureMetrics(String(lead.handledBy));
    addMetric(metrics, 'lead_added');
    if (lead.enquireStatus === 'visit store') addMetric(metrics, 'is_visited');
  }

  const tasks = await Task.find({
    isCompleted: false,
    assigned: { $in: allowedObjectIds },
    createdAt: { $gte: start, $lte: end },
  }, { assigned: true, due: true }).lean<ITask[]>();
  const now = new Date();
  for (const task of tasks) {
    const metrics = ensureMetrics(String(task.assigned));
    addMetric(metrics, 'pending_tasks');
    if (task.due < now) addMetric(metrics, 'overdue_tasks');
  }

  return metricsByUser;
};

const snapshotBranch = async (branch: IBranch, start: Date, end: Date) => {
  const branchId = branch._id;
  const rosterRoles = new Map<string, string>();
  if (branch.manager) rosterRoles.set(String(branch.manager), 'manager');
  for (const staffId of branch.staffs ?? []) rosterRoles.set(String(staffId), 'staff');

  const memberships = await BranchMembership.find({
    branch: branchId,
    startedAt: { $lte: end },
    $or: [
      { endedAt: { $exists: false } },
      { endedAt: { $gte: start } },
    ],
  }, { user: true, role: true, startedAt: true, endedAt: true, endReason: true }).lean();

  const membershipByUser = new Map<string, typeof memberships[number][]>();
  for (const membership of memberships) {
    const userId = String(membership.user);
    membershipByUser.set(userId, [...(membershipByUser.get(userId) ?? []), membership]);
  }

  const activityUserIds = await Activity.distinct('activator', {
    actorBranch: branchId,
    createdAt: { $gte: start, $lte: end },
  });

  const candidateIdStrings = new Set<string>([
    ...memberships.map(item => String(item.user)),
    ...activityUserIds.map(String),
  ]);
  const candidateIds = [...candidateIdStrings].map(id => Types.ObjectId.createFromHexString(id));
  const users = await User.find({ _id: { $in: candidateIds } }, {
    username: true,
    privilege: true,
    manager: true,
    isActive: true,
    isAccountDeleted: true,
  }).lean<UserDoc[]>();
  const userById = new Map(users.map(user => [String(user._id), user]));

  const currentMetrics = await buildMetrics(branchId, candidateIds, start, end, false);
  const metricsIgnoringActive = await buildMetrics(branchId, candidateIds, start, end, true);

  const rows: CandidateRow[] = [...candidateIdStrings].sort((a, b) => {
    const left = userById.get(a)?.username ?? a;
    const right = userById.get(b)?.username ?? b;
    return left.localeCompare(right);
  }).map(userId => {
    const user = userById.get(userId);
    const membershipItems = membershipByUser.get(userId) ?? [];
    const includedBecause = [
      ...(membershipItems.length > 0 ? ['branchMembershipOverlap'] : []),
      ...(activityUserIds.map(String).includes(userId) ? ['activityActorInBranch'] : []),
      ...(rosterRoles.has(userId) ? ['currentBranchRoster'] : []),
    ];
    const membershipStatus = membershipItems.length === 0
      ? 'none'
      : membershipItems.some(item => !item.endedAt)
        ? 'open'
        : `ended:${membershipItems.map(item => item.endReason ?? 'unknown').join(',')}`;
    const reportMetrics = currentMetrics.get(userId) ?? emptyMetrics();
    const actualMetrics = metricsIgnoringActive.get(userId) ?? emptyMetrics();

    return {
      userId,
      username: user?.username ?? 'Unknown user',
      privilege: user?.privilege ?? 'unknown',
      isActive: user?.isActive === true,
      isAccountDeleted: user?.isAccountDeleted === true,
      includedBecause,
      membershipStatus,
      currentRosterRole: rosterRoles.get(userId) ?? null,
      currentReportMetrics: reportMetrics,
      metricsIgnoringActiveUserFilter: actualMetrics,
      wouldRenderAsZeroRowToday: isZeroMetrics(reportMetrics),
      hasHiddenCountsBecauseInactive: isZeroMetrics(reportMetrics) && !isZeroMetrics(actualMetrics),
    };
  });

  const zeroRows = rows.filter(row => row.wouldRenderAsZeroRowToday);
  const inactiveRows = rows.filter(row => !row.isActive);
  const hiddenInactiveRows = rows.filter(row => row.hasHiddenCountsBecauseInactive);

  return {
    branchId: String(branch._id),
    branchName: branch.name,
    branchIsActive: branch.isActive === true,
    currentRosterSize: rosterRoles.size,
    reportCandidateCount: rows.length,
    nonZeroRowCount: rows.length - zeroRows.length,
    zeroRowCount: zeroRows.length,
    inactiveCandidateCount: inactiveRows.length,
    inactiveZeroRowCount: inactiveRows.filter(row => row.wouldRenderAsZeroRowToday).length,
    hiddenInactiveCountRows: hiddenInactiveRows.length,
    zeroRows: zeroRows.map(row => ({
      userId: row.userId,
      username: row.username,
      isActive: row.isActive,
      privilege: row.privilege,
      includedBecause: row.includedBecause,
      membershipStatus: row.membershipStatus,
      currentRosterRole: row.currentRosterRole,
    })),
    hiddenInactiveRows,
    rows,
  };
};

const run = async () => {
  const args = parseArgs();
  await connectDb();
  const branches = await resolveBranches(args);
  const branchSnapshots = [];

  for (const branch of branches) {
    branchSnapshots.push(await snapshotBranch(branch, args.start, args.end));
  }

  const result = {
    generatedAt: new Date().toISOString(),
    range: {
      start: args.start.toISOString(),
      end: args.end.toISOString(),
      timezoneInterpretation: 'Asia/Kolkata calendar day',
    },
    scope: {
      branch: args.branch ?? null,
      manager: args.manager ?? null,
      allBranches: args.includeAllBranches || (!args.branch && !args.manager),
    },
    totals: {
      branches: branchSnapshots.length,
      reportCandidateCount: branchSnapshots.reduce((sum, branch) => sum + branch.reportCandidateCount, 0),
      nonZeroRowCount: branchSnapshots.reduce((sum, branch) => sum + branch.nonZeroRowCount, 0),
      zeroRowCount: branchSnapshots.reduce((sum, branch) => sum + branch.zeroRowCount, 0),
      inactiveCandidateCount: branchSnapshots.reduce((sum, branch) => sum + branch.inactiveCandidateCount, 0),
      inactiveZeroRowCount: branchSnapshots.reduce((sum, branch) => sum + branch.inactiveZeroRowCount, 0),
      hiddenInactiveCountRows: branchSnapshots.reduce((sum, branch) => sum + branch.hiddenInactiveCountRows, 0),
    },
    branches: branchSnapshots,
  };

  const json = JSON.stringify(result, null, 2);
  const outputPath = path.resolve(args.out ?? defaultSnapshotPath(args.start, args.end));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${json}\n`);

  console.log(JSON.stringify({
    message: 'Activity report snapshot written',
    outputPath,
    generatedAt: result.generatedAt,
    range: result.range,
    scope: result.scope,
    totals: result.totals,
  }, null, 2));

  await mongoose.connection.close();
};

if (require.main === module) {
  run().catch(async (error) => {
    console.error(error);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
}
