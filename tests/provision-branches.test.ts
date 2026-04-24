import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('firebase-admin/app', () => ({
  __esModule: true,
  initializeApp: jest.fn(),
}));

jest.mock('firebase-admin', () => ({
  __esModule: true,
  credential: {
    cert: jest.fn(),
  },
}));

jest.mock('../src/services/wish-birth-day', () => ({
  __esModule: true,
  wishBirthDayToCustomers: jest.fn(),
}));

jest.mock('../src/services/task-scheduler', () => ({
  __esModule: true,
  startTaskScheduler: jest.fn(),
}));

jest.mock('../src/services/notification-services', () => ({
  __esModule: true,
  createNotificationForUsers: async () => undefined,
  getNotifications: async () => [],
  sendPushNotification: async () => undefined,
}));

import User from '../src/models/User';
import Branch from '../src/models/Branch';
import BranchMembership from '../src/models/BranchMembership';
import { buildProvisionPlan, provisionBranchesFromManagers } from '../src/scripts/provisionBranchesFromManagers';

jest.setTimeout(60000);

describe('provisionBranchesFromManagers', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'provision-branches-test',
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await User.create([
      {
        username: 'admin',
        password: 'password123',
        privilege: 'admin',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'manager-a',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'manager-b',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'manager-inactive',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'staff-a1',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'staff-a2',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'staff-b1',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'staff-b2-deleted',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: true,
      },
    ]);

    const managerA = await User.findOne({ username: 'manager-a' }).lean();
    const managerB = await User.findOne({ username: 'manager-b' }).lean();
    const staffA1 = await User.findOne({ username: 'staff-a1' });
    const staffA2 = await User.findOne({ username: 'staff-a2' });
    const staffB1 = await User.findOne({ username: 'staff-b1' });
    const staffB2Deleted = await User.findOne({ username: 'staff-b2-deleted' });

    staffA1!.manager = managerA!._id;
    staffA2!.manager = managerA!._id;
    staffB1!.manager = managerB!._id;
    staffB2Deleted!.manager = managerB!._id;
    await staffA1!.save();
    await staffA2!.save();
    await staffB1!.save();
    await staffB2Deleted!.save();
  });

  it('builds a dry-run plan and skips existing Branch N names', async () => {
    const managerA = await User.findOne({ username: 'manager-a' }).lean();
    const admin = await User.findOne({ username: 'admin' }).lean();
    await Branch.create({
      name: 'Branch 1',
      normalizedName: 'branch 1',
      manager: managerA!._id,
      staffs: [],
      isActive: true,
      createdBy: admin!._id,
    });

    const plan = await buildProvisionPlan({});
    expect(plan.totalActiveManagers).toBe(2);
    expect(plan.managersAlreadyWithBranch).toHaveLength(1);
    expect(plan.branchesToCreate).toHaveLength(1);
    expect(plan.branchesToCreate[0].managerUsername).toBe('manager-b');
    expect(plan.branchesToCreate[0].branchName).toBe('Branch 2');
    expect(plan.branchesToCreate[0].staffUsernames).toEqual(['staff-b1', 'staff-b2-deleted']);
  });

  it('creates branches only for missing active managers and is idempotent', async () => {
    const firstRun = await provisionBranchesFromManagers({ dryRun: false, apply: true });
    expect(firstRun.createdBranches).toHaveLength(2);

    const branches = await Branch.find({}).sort({ name: 1 }).lean();
    expect(branches.map(branch => branch.name)).toEqual(['Branch 1', 'Branch 2']);
    expect(branches.find(branch => branch.name === 'Branch 1')?.staffs).toHaveLength(2);
    expect(branches.find(branch => branch.name === 'Branch 2')?.staffs).toHaveLength(2);

    const memberships = await BranchMembership.find({ endedAt: { $exists: false } }).lean();
    expect(memberships).toHaveLength(6);

    const secondRun = await provisionBranchesFromManagers({ dryRun: false, apply: true });
    expect(secondRun.createdBranches).toHaveLength(0);
    expect(secondRun.managersAlreadyWithBranch).toHaveLength(2);
    expect(await Branch.countDocuments()).toBe(2);
  });

  it('supports limit and single-manager targeting', async () => {
    const managerB = await User.findOne({ username: 'manager-b' }).lean();

    const limited = await buildProvisionPlan({ limit: 1 });
    expect(limited.branchesToCreate).toHaveLength(1);

    const targeted = await buildProvisionPlan({ manager: String(managerB!._id) });
    expect(targeted.totalActiveManagers).toBe(1);
    expect(targeted.branchesToCreate).toHaveLength(1);
    expect(targeted.branchesToCreate[0].managerUsername).toBe('manager-b');
  });

  it('fails closed when no active admin exists', async () => {
    await User.updateMany({ privilege: 'admin' }, { $set: { isActive: false } });

    await expect(
      provisionBranchesFromManagers({ dryRun: false, apply: true })
    ).rejects.toThrow('No active admin user found');
  });
});
