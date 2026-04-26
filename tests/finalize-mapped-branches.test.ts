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

import Branch from '../src/models/Branch';
import BranchMembership from '../src/models/BranchMembership';
import User from '../src/models/User';
import { buildMappedBranchPlan, finalizeMappedManagerBranches } from '../src/scripts/finalizeMappedManagerBranches';

jest.setTimeout(60000);

describe('finalizeMappedManagerBranches', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'finalize-mapped-branches-test',
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
        username: 'AFNAS',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'AFNAS AV',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: '0987654320',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'Ajinas Iritty',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'Demo manager',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'TEST manager 1',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'tttt',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'accounts-staff',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'iritty-staff',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: false,
      },
      {
        username: 'test-staff',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: false,
        isAccountDeleted: true,
      },
    ]);

    const afnas = await User.findOne({ username: 'AFNAS' });
    const afnasAv = await User.findOne({ username: 'AFNAS AV' });
    const ajinas = await User.findOne({ username: 'Ajinas Iritty' });
    const demoManager = await User.findOne({ username: 'Demo manager' });
    const accountsStaff = await User.findOne({ username: 'accounts-staff' });
    const irittyStaff = await User.findOne({ username: 'iritty-staff' });
    const testStaff = await User.findOne({ username: 'test-staff' });

    accountsStaff!.manager = afnasAv!._id;
    irittyStaff!.manager = ajinas!._id;
    testStaff!.manager = demoManager!._id;
    await accountsStaff!.save();
    await irittyStaff!.save();
    await testStaff!.save();
  });

  it('builds mapped branch groups with shared branch names', async () => {
    const plan = await buildMappedBranchPlan();
    expect(plan.branchNames).toEqual(expect.arrayContaining(['Accounts', 'Iritty', 'Test Branch']));

    const accounts = plan.branchesToApply.find(item => item.branchName === 'Accounts');
    expect(accounts?.primaryManagerUsername).toBe('AFNAS');
    expect(accounts?.managerUsernames).toEqual(['AFNAS', 'AFNAS AV', '0987654320']);
    expect(accounts?.staffUsernames).toEqual(['accounts-staff']);
  });

  it('creates mapped branches and manager memberships without rewriting staff manager links', async () => {
    const result = await finalizeMappedManagerBranches({ dryRun: false, apply: true });
    expect(result.appliedBranches.map(item => item.branchName)).toEqual(expect.arrayContaining(['Accounts', 'Iritty', 'Test Branch']));

    const accounts = await Branch.findOne({ normalizedName: 'accounts' }).lean();
    const iritty = await Branch.findOne({ normalizedName: 'iritty' }).lean();
    const testBranch = await Branch.findOne({ normalizedName: 'test branch' }).lean();
    expect(accounts).toBeTruthy();
    expect(accounts?.manager).toBeTruthy();
    expect(accounts?.staffs).toHaveLength(1);
    expect(iritty?.staffs).toHaveLength(1);
    expect(testBranch?.staffs).toHaveLength(1);

    const openMemberships = await BranchMembership.find({ endedAt: { $exists: false } }).lean();
    const accountsMemberships = openMemberships.filter(item => String(item.branch) === String(accounts!._id));
    expect(accountsMemberships.filter(item => item.role === 'manager')).toHaveLength(3);

    const afnasAv = await User.findOne({ username: 'AFNAS AV' }).lean();
    expect(accountsMemberships.some(item => String(item.user) === String(afnasAv!._id) && item.role === 'manager')).toBe(true);

    const accountsStaff = await User.findOne({ username: 'accounts-staff' }).lean();
    const irittyStaff = await User.findOne({ username: 'iritty-staff' }).lean();
    expect(String(accountsStaff!.manager)).toBe(String(afnasAv!._id));
    expect(String(irittyStaff!.manager)).toBe(String((await User.findOne({ username: 'Ajinas Iritty' }).lean())!._id));
  });
});
