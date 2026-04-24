import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: {
    sign: (payload: unknown) =>
      `mock.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
    verify: (token: string) => {
      const encoded = token.split('.')[1];
      if (!encoded) {
        throw new Error('Invalid token');
      }
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    },
  },
}));

jest.mock('../src/services/notification-services', () => ({
  __esModule: true,
  createNotificationForUsers: async () => undefined,
  getNotifications: async (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) =>
    res.status(200).json([]),
  sendPushNotification: async () => undefined,
}));

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

import app from '../src/server';
import User from '../src/models/User';
import Branch from '../src/models/Branch';
import BranchMembership from '../src/models/BranchMembership';
import Lead from '../src/models/Lead';
import Target from '../src/models/Target';

jest.setTimeout(60000);

describe('Branch management e2e', () => {
  let mongo: MongoMemoryServer;

  const seedUsers = async () => {
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
        username: 'safvan',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'call-center',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'staff-two',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
    ]);
  };

  const login = async (username: string) => {
    const response = await request(app).post('/api/auth/login').send({
      username,
      password: 'password123',
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toBeTruthy();
    return response.body.token as string;
  };

  const getUserId = async (username: string) => {
    const user = await User.findOne({ username }).select('_id').lean();
    expect(user).toBeTruthy();
    return String(user!._id);
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'branch-management-e2e',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await seedUsers();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('rejects active branch creation without a manager and allows inactive branches without one', async () => {
    const adminToken = await login('admin');

    const activeMissingManager = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Calicut',
      });

    expect(activeMissingManager.status).toBe(400);
    expect(activeMissingManager.body.message).toContain('manager');

    const inactiveBranch = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Temporary Branch',
        isActive: false,
      });

    expect(inactiveBranch.status).toBe(201);
    expect(inactiveBranch.body.name).toBe('Temporary Branch');
    expect(inactiveBranch.body.isActive).toBe(false);
    expect(inactiveBranch.body.manager).toBeUndefined();
  });

  it('blocks non-admin access and supports staff transfer with in-memory mongodb', async () => {
    const adminToken = await login('admin');
    const managerToken = await login('manager-a');

    const forbiddenResponse = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        name: 'Manager Attempt',
      });

    expect(forbiddenResponse.status).toBe(403);

    const branchOne = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch One',
        managerId: await getUserId('manager-a'),
      });

    expect(branchOne.status).toBe(201);

    const branchTwo = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch Two',
        managerId: await getUserId('manager-b'),
      });

    expect(branchTwo.status).toBe(201);

    const staffId = await getUserId('safvan');
    const branchOneId = branchOne.body._id as string;
    const branchTwoId = branchTwo.body._id as string;

    const addToFirst = await request(app)
      .post(`/api/branches/${branchOneId}/staff`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        staffIds: [staffId],
      });

    expect(addToFirst.status).toBe(200);
    expect(addToFirst.body.staffs).toHaveLength(1);
    expect(addToFirst.body.staffs[0].username).toBe('safvan');

    const conflictResponse = await request(app)
      .post(`/api/branches/${branchTwoId}/staff`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        staffIds: [staffId],
      });

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.conflicts).toHaveLength(1);
    expect(conflictResponse.body.error.conflicts[0].username).toBe('safvan');

    const confirmedMove = await request(app)
      .post(`/api/branches/${branchTwoId}/staff`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        staffIds: [staffId],
        confirmMove: true,
      });

    expect(confirmedMove.status).toBe(200);
    expect(confirmedMove.body.staffs).toHaveLength(1);
    expect(confirmedMove.body.staffs[0].username).toBe('safvan');

    const refreshedBranchOne = await Branch.findById(branchOneId).lean();
    const refreshedBranchTwo = await Branch.findById(branchTwoId).lean();
    const movedUser = await User.findById(staffId).lean();
    const oldMembership = await BranchMembership.findOne({
      branch: branchOneId,
      user: staffId,
      endedAt: { $exists: true },
    }).lean();
    const newMembership = await BranchMembership.findOne({
      branch: branchTwoId,
      user: staffId,
      endedAt: { $exists: false },
    }).lean();

    expect(refreshedBranchOne?.staffs.map(String)).not.toContain(staffId);
    expect(refreshedBranchTwo?.staffs.map(String)).toContain(staffId);
    expect(String(movedUser?.manager)).toBe(String(branchTwo.body.manager._id));
    expect(oldMembership?.endReason).toBe('transferred');
    expect(newMembership?.role).toBe('staff');

    const inactivatedBranch = await request(app)
      .patch(`/api/branches/${branchTwoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        isActive: false,
      });

    expect(inactivatedBranch.status).toBe(200);
    expect(inactivatedBranch.body.isActive).toBe(false);
    expect(inactivatedBranch.body.manager.username).toBe('manager-b');
  });

  it('stamps branch snapshots and credits call-center creator plus closer branch targets', async () => {
    const adminToken = await login('admin');
    const callCenterToken = await login('safvan');
    const closerToken = await login('staff-two');

    const branchOne = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch One',
        managerId: await getUserId('manager-a'),
        staffIds: [await getUserId('safvan')],
      });
    expect(branchOne.status).toBe(201);

    const branchTwo = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch Two',
        managerId: await getUserId('manager-b'),
        staffIds: [await getUserId('staff-two')],
      });
    expect(branchTwo.status).toBe(201);

    const createLead = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${callCenterToken}`)
      .send({
        name: 'Customer One',
        phone: '9999990001',
        product: 'iPhone',
        source: 'call',
        enquireStatus: 'new',
        purpose: 'purchase',
        type: 'fresh',
      });
    expect(createLead.status).toBe(200);

    const leadAfterCreate = await Lead.findById(createLead.body._id).lean();
    expect(String(leadAfterCreate?.createdBranch)).toBe(branchOne.body._id);
    expect(String(leadAfterCreate?.handlingBranch)).toBe(branchOne.body._id);

    const transfer = await request(app)
      .put(`/api/leads/status/${createLead.body._id}`)
      .set('Authorization', `Bearer ${callCenterToken}`)
      .send({ transferTo: 'staff-two' });
    expect(transfer.status).toBe(200);

    const leadAfterTransfer = await Lead.findById(createLead.body._id).lean();
    expect(String(leadAfterTransfer?.createdBranch)).toBe(branchOne.body._id);
    expect(String(leadAfterTransfer?.handlingBranch)).toBe(branchTwo.body._id);

    const won = await request(app)
      .put(`/api/leads/status/${createLead.body._id}`)
      .set('Authorization', `Bearer ${closerToken}`)
      .send({ enquireStatus: 'won' });
    expect(won.status).toBe(200);

    const leadAfterWon = await Lead.findById(createLead.body._id).lean();
    expect(String(leadAfterWon?.wonBranch)).toBe(branchTwo.body._id);
    expect(String(leadAfterWon?.wonBy)).toBe(await getUserId('staff-two'));

    const branchOneTarget = await Target.findOne({
      scope: 'branch',
      branch: branchOne.body._id,
    }).lean();
    const branchTwoTarget = await Target.findOne({
      scope: 'branch',
      branch: branchTwo.body._id,
    }).lean();
    const creatorAllocation = await Target.findOne({
      scope: 'allocation',
      branch: branchOne.body._id,
      assigned: await getUserId('safvan'),
    }).lean();
    const closerAllocation = await Target.findOne({
      scope: 'allocation',
      branch: branchTwo.body._id,
      assigned: await getUserId('staff-two'),
    }).lean();

    expect(branchOneTarget?.achieved).toBe(1);
    expect(branchTwoTarget?.achieved).toBe(1);
    expect(creatorAllocation?.achieved).toBe(1);
    expect(closerAllocation?.achieved).toBe(1);
  });

  it('maps old manager assigned target payload to branch target when manager owns a branch', async () => {
    const adminToken = await login('admin');
    const managerId = await getUserId('manager-a');

    const branch = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Manager Branch',
        managerId,
      });
    expect(branch.status).toBe(201);

    const addTarget = await request(app)
      .post('/api/target')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        assigned: managerId,
        total: 25,
        month: Date.now(),
      });
    expect(addTarget.status).toBe(200);

    const branchTarget = await Target.findOne({
      scope: 'branch',
      branch: branch.body._id,
    }).lean();
    const legacyTarget = await Target.findOne({
      scope: 'legacy',
      assigned: managerId,
    }).lean();

    expect(branchTarget?.total).toBe(25);
    expect(legacyTarget).toBeNull();
  });
});
