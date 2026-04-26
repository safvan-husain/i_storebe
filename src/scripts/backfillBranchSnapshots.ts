import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import Lead from '../models/Lead';
import Activity from '../models/Activity';
import BranchMembership from '../models/BranchMembership';

type Args = {
  dryRun: boolean;
  apply: boolean;
  force: boolean;
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
  }, null, 2));

  await mongoose.connection.close();
};

run().catch(async (error) => {
  console.error(error);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
