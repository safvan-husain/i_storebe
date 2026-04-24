import 'dotenv/config';
import mongoose from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import BranchMembership from '../models/BranchMembership';
import User from '../models/User';
import { branchService } from '../services/branch-service';
import { syncOpenMembershipsForBranch } from '../services/branch-context';

type Args = {
  dryRun: boolean;
  apply: boolean;
  limit?: number;
  manager?: string;
};

type PlannedBranch = {
  managerId: string;
  managerUsername: string;
  branchName: string;
  staffIds: string[];
  staffUsernames: string[];
};

type ProvisionSummary = {
  mode: 'dry-run' | 'apply';
  totalActiveManagers: number;
  managersAlreadyWithBranch: Array<{ managerId: string; username: string; branchId: string; branchName: string }>;
  managersMissingBranch: Array<{ managerId: string; username: string }>;
  branchesToCreate: PlannedBranch[];
  createdBranches: Array<{ managerId: string; username: string; branchId: string; branchName: string }>;
  skippedManagers: Array<{ managerId: string; username: string; reason: string }>;
  failures: Array<{ managerId: string; username: string; error: string }>;
  generatedNames: string[];
};

const normalizeBranchName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export const parseArgs = (argv = process.argv.slice(2)): Args => {
  const parsed: Args = {
    dryRun: true,
    apply: false,
  };

  const getVal = (i: number) => (i + 1 < argv.length ? argv[i + 1] : undefined);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      parsed.apply = true;
      parsed.dryRun = false;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      parsed.apply = false;
      continue;
    }
    if (arg === '--limit') {
      const value = getVal(i);
      if (value) parsed.limit = Number(value);
      i++;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      parsed.limit = Number(arg.split('=')[1]);
      continue;
    }
    if (arg === '--manager') {
      const value = getVal(i);
      if (value) parsed.manager = value;
      i++;
      continue;
    }
    if (arg.startsWith('--manager=')) {
      parsed.manager = arg.split('=')[1];
      continue;
    }
  }

  return parsed;
};

const getNextBranchNameFactory = async () => {
  const existing = await Branch.find({}, { normalizedName: true }).lean();
  const taken = new Set(existing.map(branch => branch.normalizedName));
  let sequence = 1;

  return () => {
    while (taken.has(normalizeBranchName(`Branch ${sequence}`))) {
      sequence++;
    }
    const name = `Branch ${sequence}`;
    taken.add(normalizeBranchName(name));
    sequence++;
    return name;
  };
};

const findProvisionAdmin = async () => {
  return User.findOne({
    privilege: 'admin',
    isActive: true,
    isAccountDeleted: { $ne: true },
  }, { username: true, privilege: true })
    .sort({ createdAt: 1, username: 1 })
    .lean();
};

export const buildProvisionPlan = async ({
  limit,
  manager,
}: {
  limit?: number;
  manager?: string;
}) => {
  const managerQuery: Record<string, any> = {
    privilege: 'manager',
    isActive: true,
    isAccountDeleted: { $ne: true },
  };
  if (manager) managerQuery._id = manager;

  const managers = await User.find(managerQuery, { username: true })
    .sort({ username: 1 })
    .lean();

  const branches = await Branch.find({ manager: { $in: managers.map(item => item._id) } }, {
    name: true,
    manager: true,
  }).lean();
  const existingByManager = new Map(branches.map(branch => [String(branch.manager), branch]));
  const nextBranchName = await getNextBranchNameFactory();

  const managersAlreadyWithBranch = managers
    .filter(managerUser => existingByManager.has(String(managerUser._id)))
    .map(managerUser => {
      const branch = existingByManager.get(String(managerUser._id))!;
      return {
        managerId: String(managerUser._id),
        username: managerUser.username,
        branchId: String(branch._id),
        branchName: branch.name,
      };
    });

  const missingManagers = managers.filter(managerUser => !existingByManager.has(String(managerUser._id)));
  const limitedManagers = typeof limit === 'number' ? missingManagers.slice(0, limit) : missingManagers;

  const branchesToCreate: PlannedBranch[] = [];
  for (const managerUser of limitedManagers) {
    const staffs = await User.find({
      privilege: 'staff',
      manager: managerUser._id,
    }, { username: true }).sort({ username: 1 }).lean();

    branchesToCreate.push({
      managerId: String(managerUser._id),
      managerUsername: managerUser.username,
      branchName: nextBranchName(),
      staffIds: staffs.map(staff => String(staff._id)),
      staffUsernames: staffs.map(staff => staff.username),
    });
  }

  return {
    totalActiveManagers: managers.length,
    managersAlreadyWithBranch,
    managersMissingBranch: missingManagers.map(managerUser => ({
      managerId: String(managerUser._id),
      username: managerUser.username,
    })),
    branchesToCreate,
  };
};

export const provisionBranchesFromManagers = async ({
  dryRun,
  apply,
  limit,
  manager,
}: Args): Promise<ProvisionSummary> => {
  const admin = await findProvisionAdmin();
  if (!admin) {
    throw new Error('No active admin user found. Cannot provision branches without an admin actor.');
  }

  const plan = await buildProvisionPlan({ limit, manager });
  const summary: ProvisionSummary = {
    mode: apply ? 'apply' : 'dry-run',
    totalActiveManagers: plan.totalActiveManagers,
    managersAlreadyWithBranch: plan.managersAlreadyWithBranch,
    managersMissingBranch: plan.managersMissingBranch,
    branchesToCreate: plan.branchesToCreate,
    createdBranches: [],
    skippedManagers: [],
    failures: [],
    generatedNames: plan.branchesToCreate.map(item => item.branchName),
  };

  if (dryRun || !apply) {
    return summary;
  }

  for (const item of plan.branchesToCreate) {
    try {
      const activeOrInactiveStaffIds = item.staffIds;
      const creatableStaffs = await User.find({
        _id: { $in: activeOrInactiveStaffIds },
        privilege: 'staff',
        isAccountDeleted: { $ne: true },
      }, { _id: 1 }).lean();
      const creatableStaffIds = creatableStaffs.map(user => String(user._id));
      const deletedStaffIds = activeOrInactiveStaffIds.filter(id => !creatableStaffIds.includes(id));

      const branch = await branchService.createBranch({
        userId: String(admin._id),
        username: admin.username,
        privilege: admin.privilege,
      }, {
        name: item.branchName,
        managerId: item.managerId,
        staffIds: creatableStaffIds,
        isActive: true,
        confirmMove: true,
      });

      if (deletedStaffIds.length > 0) {
        const branchDoc = await Branch.findById((branch as any)?._id);
        if (branchDoc) {
          const mergedStaffIds = [...new Set([
            ...branchDoc.staffs.map(id => String(id)),
            ...deletedStaffIds,
          ])].map(id => new mongoose.Types.ObjectId(id));
          branchDoc.staffs = mergedStaffIds as any;
          await branchDoc.save();
          await syncOpenMembershipsForBranch({
            branch: branchDoc._id,
            manager: branchDoc.manager,
            staffs: branchDoc.staffs,
            actor: new mongoose.Types.ObjectId(String(admin._id)),
          });
        }
      }

      summary.createdBranches.push({
        managerId: item.managerId,
        username: item.managerUsername,
        branchId: String((branch as any)?._id),
        branchName: (branch as any)?.name ?? item.branchName,
      });
    } catch (error) {
      summary.failures.push({
        managerId: item.managerId,
        username: item.managerUsername,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
};

const runCli = async () => {
  const args = parseArgs();
  await connectDb();

  try {
    const result = await provisionBranchesFromManagers(args);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.connection.close();
  }
};

if (require.main === module) {
  runCli().catch(async (error) => {
    console.error(error);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
}
