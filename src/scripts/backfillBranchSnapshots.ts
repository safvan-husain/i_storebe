import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import Lead from '../models/Lead';
import Activity from '../models/Activity';
import BranchMembership from '../models/BranchMembership';
import User from '../models/User';

type Args = {
  dryRun: boolean;
  apply: boolean;
  force: boolean;
};

export type MembershipStartedAtUpdate = {
  membershipId: string;
  username?: string;
  branchName?: string;
  previousStartedAt: Date;
  nextStartedAt: Date;
};

export const computeMembershipStartedAt = async (options: {
  userId: Types.ObjectId;
  branchId: Types.ObjectId;
  currentStartedAt: Date;
  userCreatedAt?: Date | null;
}): Promise<Date> => {
  const { userId, branchId, currentStartedAt, userCreatedAt } = options;
  const candidateTimes = [currentStartedAt.getTime()];
  if (userCreatedAt) candidateTimes.push(userCreatedAt.getTime());

  const earliestActivity = await Activity.findOne({
    activator: userId,
    actorBranch: branchId,
  }, { createdAt: true }).sort({ createdAt: 1 }).lean();
  if (earliestActivity?.createdAt) candidateTimes.push(earliestActivity.createdAt.getTime());

  const earliestLead = await Lead.findOne({
    createdBy: userId,
    $or: [
      { createdBranch: branchId },
      { handlingBranch: branchId },
    ],
  }, { createdAt: true }).sort({ createdAt: 1 }).lean();
  if (earliestLead?.createdAt) candidateTimes.push(earliestLead.createdAt.getTime());

  return new Date(Math.min(...candidateTimes));
};

export const backfillMembershipStartedAt = async (args: Pick<Args, 'apply'>) => {
  const openMemberships = await BranchMembership.find({
    endedAt: { $exists: false },
  }).lean();

  const userIds = [...new Set(openMemberships.map(item => String(item.user)))];
  const branchIds = [...new Set(openMemberships.map(item => String(item.branch)))];
  const users = await User.find({ _id: { $in: userIds } }, { username: true, createdAt: true }).lean();
  const branches = await Branch.find({ _id: { $in: branchIds } }, { name: true }).lean();
  const userById = new Map(users.map(user => [String(user._id), user]));
  const branchById = new Map(branches.map(branch => [String(branch._id), branch]));

  const updates: MembershipStartedAtUpdate[] = [];

  for (const membership of openMemberships) {
    const user = userById.get(String(membership.user));
    const branch = branchById.get(String(membership.branch));
    const nextStartedAt = await computeMembershipStartedAt({
      userId: membership.user as Types.ObjectId,
      branchId: membership.branch as Types.ObjectId,
      currentStartedAt: membership.startedAt,
      userCreatedAt: user?.createdAt,
    });

    if (nextStartedAt.getTime() >= membership.startedAt.getTime()) continue;

    const update: MembershipStartedAtUpdate = {
      membershipId: String(membership._id),
      username: user?.username,
      branchName: branch?.name,
      previousStartedAt: membership.startedAt,
      nextStartedAt,
    };
    updates.push(update);

    if (args.apply) {
      await BranchMembership.updateOne(
        { _id: membership._id },
        { $set: { startedAt: nextStartedAt } },
      );
    }
  }

  return {
    membershipsReviewed: openMemberships.length,
    membershipsStartedAtUpdated: updates.length,
    membershipStartedAtSamples: updates.slice(0, 20),
  };
};

const parseArgs = (): Args => {
  const args = new Set(process.argv.slice(2));
  return {
    dryRun: args.has('--dry-run') || !args.has('--apply'),
    apply: args.has('--apply'),
    force: args.has('--force'),
  };
};

const id = (value?: any) => value ? String(value) : undefined;

const run = async () => {
  const args = parseArgs();
  await connectDb();

  const branches = await Branch.find({}, { manager: true, staffs: true, createdAt: true, name: true }).lean();
  const userBranch = new Map<string, Types.ObjectId>();

  for (const branch of branches) {
    if (branch.manager) userBranch.set(String(branch.manager), branch._id);
    for (const staff of branch.staffs ?? []) userBranch.set(String(staff), branch._id);
  }

  const openMemberships = await BranchMembership.find({
    endedAt: { $exists: false },
  }, { user: true, branch: true }).lean();
  for (const membership of openMemberships) {
    if (!userBranch.has(String(membership.user))) {
      userBranch.set(String(membership.user), membership.branch);
    }
  }

  let membershipsToCreate = 0;
  let leadsMatched = 0;
  let leadsUnresolved = 0;
  let activitiesMatched = 0;
  let activitiesUnresolved = 0;
  const unresolvedLeadIds: string[] = [];
  const unresolvedActivityIds: string[] = [];

  for (const branch of branches) {
    const memberships = [
      ...(branch.manager ? [{ user: branch.manager, role: 'manager' as const }] : []),
      ...(branch.staffs ?? []).map(user => ({ user, role: 'staff' as const })),
    ];

    for (const membership of memberships) {
      const exists = await BranchMembership.findOne({
        branch: branch._id,
        user: membership.user,
        role: membership.role,
        endedAt: { $exists: false },
      }, { _id: true }).lean();
      if (exists) continue;
      membershipsToCreate++;
      if (args.apply) {
        await BranchMembership.create({
          branch: branch._id,
          user: membership.user,
          role: membership.role,
          startedAt: branch.createdAt ?? new Date(),
        });
      }
    }
  }

  const leads = await Lead.find({}).lean();
  for (const lead of leads) {
    const createdBranch = userBranch.get(id(lead.createdBy) ?? '');
    const handlingBranch =
      userBranch.get(id(lead.handledBy) ?? '') ??
      userBranch.get(id(lead.manager) ?? '') ??
      createdBranch;
    const wonBranch = lead.enquireStatus === 'won' ? handlingBranch : undefined;

    if (!createdBranch && !handlingBranch) {
      leadsUnresolved++;
      if (unresolvedLeadIds.length < 10) unresolvedLeadIds.push(String(lead._id));
      continue;
    }

    const $set: Record<string, Types.ObjectId> = {};
    if ((args.force || !lead.createdBranch) && createdBranch) $set.createdBranch = createdBranch;
    if ((args.force || !lead.handlingBranch) && handlingBranch) $set.handlingBranch = handlingBranch;
    if ((args.force || !lead.wonBranch) && wonBranch) $set.wonBranch = wonBranch;

    if (Object.keys($set).length > 0) {
      leadsMatched++;
      if (args.apply) await Lead.updateOne({ _id: lead._id }, { $set });
    }
  }

  const activities = await Activity.find({}).lean();
  for (const activity of activities) {
    const actorBranch = userBranch.get(id(activity.activator) ?? '');
    if (!actorBranch) {
      activitiesUnresolved++;
      if (unresolvedActivityIds.length < 10) unresolvedActivityIds.push(String(activity._id));
      continue;
    }
    if (args.force || !activity.actorBranch) {
      activitiesMatched++;
      if (args.apply) await Activity.updateOne({ _id: activity._id }, { $set: { actorBranch } });
    }
  }

  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    force: args.force,
    branches: branches.length,
    userBranchMappings: userBranch.size,
    membershipsToCreate,
    leadsToUpdate: leadsMatched,
    leadsUnresolved,
    unresolvedLeadIds,
    activitiesToUpdate: activitiesMatched,
    activitiesUnresolved,
    unresolvedActivityIds,
    ...(await backfillMembershipStartedAt({ apply: args.apply })),
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
