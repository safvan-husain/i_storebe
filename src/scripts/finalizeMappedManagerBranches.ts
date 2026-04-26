import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import BranchMembership from '../models/BranchMembership';
import User from '../models/User';
import {
  closeOpenMembershipsForUsers,
  openMemberships,
} from '../services/branch-context';

type Args = {
  dryRun: boolean;
  apply: boolean;
};

type MappingEntry = {
  username: string;
  branchName: string;
  testOnly?: boolean;
};

type PlannedBranch = {
  branchName: string;
  primaryManagerId?: string;
  primaryManagerUsername?: string;
  managerUsernames: string[];
  extraManagerIds: string[];
  staffIds: string[];
  staffUsernames: string[];
  action: 'create' | 'update';
};

type Summary = {
  mode: 'dry-run' | 'apply';
  branchNames: string[];
  missingManagers: string[];
  branchesToApply: PlannedBranch[];
  appliedBranches: Array<{ branchId: string; branchName: string; primaryManagerUsername?: string }>;
};

const normalizeBranchName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const MAPPINGS: MappingEntry[] = [
  { username: 'AJMAL', branchName: 'Taliparamba' },
  { username: 'AFREED K', branchName: 'Mattannur' },
  { username: 'Ajmal Kannur', branchName: 'Kannur' },
  { username: 'Ajinas Iritty', branchName: 'Iritty' },
  { username: 'Abhijith Mngr', branchName: '19th Mile' },
  { username: 'payyanur mngr', branchName: 'Payyannur' },
  { username: 'Riswan', branchName: 'Call Center' },
  { username: 'AFNAS', branchName: 'Accounts' },
  { username: 'AFREED HR', branchName: 'HR' },
  { username: 'AKSHAY', branchName: '19th Mile' },
  { username: 'Abhijith Ashok MNGR', branchName: '19th Mile' },
  { username: 'SINAN', branchName: '19th Mile' },
  { username: 'AFREED', branchName: 'Mattannur' },
  { username: 'AFNAS AV', branchName: 'Accounts' },
  { username: '0987654320', branchName: 'Accounts' },
  { username: 'JAMSHI', branchName: 'Dubai Store' },
  { username: 'Demo manager', branchName: 'Test Branch', testOnly: true },
  { username: 'TEST manager 1', branchName: 'Test Branch', testOnly: true },
  { username: 'tttt', branchName: 'Test Branch', testOnly: true },
];

const parseArgs = (argv = process.argv.slice(2)): Args => ({
  dryRun: argv.includes('--dry-run') || !argv.includes('--apply'),
  apply: argv.includes('--apply'),
});

const findProvisionAdmin = async () => {
  return User.findOne({
    privilege: 'admin',
    isActive: true,
    isAccountDeleted: { $ne: true },
  }, { username: true, privilege: true })
    .sort({ createdAt: 1, username: 1 })
    .lean();
};

export const buildMappedBranchPlan = async (): Promise<Omit<Summary, 'mode' | 'appliedBranches'>> => {
  const managerUsers = await User.find({
    privilege: 'manager',
    username: { $in: MAPPINGS.map(item => item.username) },
    isAccountDeleted: { $ne: true },
  }, {
    username: true,
    isActive: true,
    isAccountDeleted: true,
  }).lean();

  const managersByUsername = new Map(managerUsers.map(user => [user.username, user]));
  const missingManagers = MAPPINGS
    .filter(item => !managersByUsername.has(item.username))
    .map(item => item.username);

  const existingBranches = await Branch.find({
    normalizedName: { $in: [...new Set(MAPPINGS.map(item => normalizeBranchName(item.branchName)))] },
  }, {
    name: true,
    normalizedName: true,
  }).lean();
  const existingByName = new Map(existingBranches.map(branch => [branch.normalizedName, branch]));

  const grouped = new Map<string, MappingEntry[]>();
  for (const entry of MAPPINGS) {
    if (!managersByUsername.has(entry.username)) continue;
    const key = normalizeBranchName(entry.branchName);
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }

  const branchesToApply: PlannedBranch[] = [];
  for (const entries of grouped.values()) {
    const managerDocs = entries
      .map(entry => managersByUsername.get(entry.username)!)
      .filter(Boolean);
    if (managerDocs.length === 0) continue;

    const primaryManager = managerDocs.find(manager => manager.isActive) ?? managerDocs[0];
    const extraManagers = managerDocs.filter(manager => String(manager._id) !== String(primaryManager._id));
    const staffs = await User.find({
      privilege: 'staff',
      manager: { $in: managerDocs.map(manager => manager._id) },
    }, {
      username: true,
    }).sort({ username: 1 }).lean();

    const branchName = entries[0].branchName;
    branchesToApply.push({
      branchName,
      primaryManagerId: String(primaryManager._id),
      primaryManagerUsername: primaryManager.username,
      managerUsernames: managerDocs.map(manager => manager.username),
      extraManagerIds: extraManagers.map(manager => String(manager._id)),
      staffIds: staffs.map(staff => String(staff._id)),
      staffUsernames: staffs.map(staff => staff.username),
      action: existingByName.has(normalizeBranchName(branchName)) ? 'update' : 'create',
    });
  }

  branchesToApply.sort((a, b) => a.branchName.localeCompare(b.branchName));

  return {
    branchNames: branchesToApply.map(item => item.branchName),
    missingManagers,
    branchesToApply,
  };
};

const pullUsersFromOtherBranches = async ({
  branchId,
  staffIds,
  primaryManagerId,
  extraManagerIds,
}: {
  branchId: Types.ObjectId;
  staffIds: Types.ObjectId[];
  primaryManagerId?: Types.ObjectId;
  extraManagerIds: Types.ObjectId[];
}) => {
  const managerIds = primaryManagerId ? [primaryManagerId, ...extraManagerIds] : extraManagerIds;
  if (managerIds.length > 0) {
    await Branch.updateMany(
      { _id: { $ne: branchId }, manager: { $in: managerIds } },
      { $unset: { manager: '' }, $set: { isActive: false } }
    );
  }
  const branchStaffIds = [...staffIds, ...extraManagerIds];
  if (branchStaffIds.length > 0) {
    await Branch.updateMany(
      { _id: { $ne: branchId }, staffs: { $in: branchStaffIds } },
      { $pull: { staffs: { $in: branchStaffIds } } }
    );
  }
};

const syncMemberships = async ({
  branchId,
  actorId,
  primaryManagerId,
  extraManagerIds,
  staffIds,
  startedAt,
}: {
  branchId: Types.ObjectId;
  actorId: Types.ObjectId;
  primaryManagerId?: Types.ObjectId;
  extraManagerIds: Types.ObjectId[];
  staffIds: Types.ObjectId[];
  startedAt: Date;
}) => {
  const desiredManagerIds = primaryManagerId ? [primaryManagerId, ...extraManagerIds] : extraManagerIds;
  const desiredAll = [...desiredManagerIds, ...staffIds];

  await closeOpenMembershipsForUsers({
    users: desiredAll,
    endedBy: actorId,
    endReason: 'transferred',
    excludeBranch: branchId,
  });

  const openOnBranch = await BranchMembership.find({
    branch: branchId,
    endedAt: { $exists: false },
  }, {
    user: true,
  }).lean();
  const desiredSet = new Set(desiredAll.map(item => String(item)));
  const toClose = openOnBranch
    .map(item => item.user as Types.ObjectId)
    .filter(userId => !desiredSet.has(String(userId)));

  await closeOpenMembershipsForUsers({
    users: toClose,
    endedBy: actorId,
    endReason: 'removed',
  });

  await openMemberships({
    branch: branchId,
    memberships: [
      ...desiredManagerIds.map(user => ({ user, role: 'manager' as const })),
      ...staffIds.map(user => ({ user, role: 'staff' as const })),
    ],
    startedBy: actorId,
    startedAt,
  });
};

export const finalizeMappedManagerBranches = async ({
  dryRun,
  apply,
}: Args): Promise<Summary> => {
  const admin = await findProvisionAdmin();
  if (!admin) {
    throw new Error('No active admin user found. Cannot finalize manager branch mappings without an admin actor.');
  }

  const plan = await buildMappedBranchPlan();
  const summary: Summary = {
    mode: apply ? 'apply' : 'dry-run',
    branchNames: plan.branchNames,
    missingManagers: plan.missingManagers,
    branchesToApply: plan.branchesToApply,
    appliedBranches: [],
  };

  if (dryRun || !apply) {
    return summary;
  }

  const actorId = new Types.ObjectId(String(admin._id));

  for (const item of plan.branchesToApply) {
    const normalizedName = normalizeBranchName(item.branchName);
    const primaryManagerId = item.primaryManagerId ? new Types.ObjectId(item.primaryManagerId) : undefined;
    const staffIds = item.staffIds.map(id => new Types.ObjectId(id));
    const extraManagerIds = item.extraManagerIds.map(id => new Types.ObjectId(id));

    let branch = await Branch.findOne({ normalizedName });
    if (!branch) {
      branch = await Branch.create({
        name: item.branchName,
        normalizedName,
        manager: primaryManagerId,
        staffs: staffIds,
        isActive: true,
        createdBy: actorId,
      });
    } else {
      branch.name = item.branchName;
      branch.normalizedName = normalizedName;
      branch.manager = primaryManagerId as any;
      branch.staffs = staffIds as any;
      branch.isActive = true;
      await branch.save();
    }

    await pullUsersFromOtherBranches({
      branchId: branch._id,
      primaryManagerId,
      staffIds,
      extraManagerIds,
    });

    await syncMemberships({
      branchId: branch._id,
      actorId,
      primaryManagerId,
      extraManagerIds,
      staffIds,
      startedAt: branch.createdAt ?? new Date(),
    });

    summary.appliedBranches.push({
      branchId: String(branch._id),
      branchName: branch.name,
      primaryManagerUsername: item.primaryManagerUsername,
    });
  }

  return summary;
};

const run = async () => {
  const args = parseArgs();
  await connectDb();
  const result = await finalizeMappedManagerBranches(args);
  console.log(JSON.stringify(result, null, 2));
  await mongoose.connection.close();
};

run().catch(async error => {
  console.error(error);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
