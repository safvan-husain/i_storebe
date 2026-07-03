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
import Lead from '../src/models/Lead';

jest.setTimeout(60000);

describe('Lead global search e2e', () => {
  let mongo: MongoMemoryServer;
  let leadId: string;

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
        username: 'staff-a',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'staff-b',
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
    return response.body.token as string;
  };

  const getUserId = async (username: string) => String((await User.findOne({ username }).lean())!._id);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'lead-global-search-e2e',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await seedUsers();

    const managerAId = await getUserId('manager-a');
    const managerBId = await getUserId('manager-b');
    const staffAId = await getUserId('staff-a');

    await User.findByIdAndUpdate(staffAId, { manager: managerAId });

    const adminToken = await login('admin');

    const branchOne = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch One',
        managerId: managerAId,
        staffIds: [staffAId],
      });
    expect(branchOne.status).toBe(201);

    const branchTwo = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch Two',
        managerId: managerBId,
      });
    expect(branchTwo.status).toBe(201);

    const staffAToken = await login('staff-a');
    const createLead = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${staffAToken}`)
      .send({
        name: 'Search Customer',
        phone: '8888777766',
        product: 'iPhone',
        source: 'call',
        enquireStatus: 'new',
        purpose: 'purchase',
        type: 'fresh',
        nearestStore: 'Store A',
      });
    expect(createLead.status).toBe(200);
    leadId = createLead.body._id;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const searchAs = async (username: string, searchTerm: string) => {
    const token = await login(username);
    return request(app)
      .post('/api/leads/global-search')
      .set('Authorization', `Bearer ${token}`)
      .send({ searchTerm, skip: 0, limit: 20 });
  };

  const canViewFor = (response: request.Response) => {
    const lead = response.body.leads.find((item: { _id: string }) => item._id === leadId);
    expect(lead).toBeTruthy();
    return lead.canViewDetails as boolean;
  };

  it('returns global results with canViewDetails based on role and branch manager', async () => {
    const adminResponse = await searchAs('admin', 'Search');
    expect(adminResponse.status).toBe(200);
    expect(canViewFor(adminResponse)).toBe(true);

    const handlerResponse = await searchAs('staff-a', 'Search');
    expect(handlerResponse.status).toBe(200);
    expect(canViewFor(handlerResponse)).toBe(true);

    const branchManagerResponse = await searchAs('manager-a', 'Search');
    expect(branchManagerResponse.status).toBe(200);
    expect(canViewFor(branchManagerResponse)).toBe(true);

    const unrelatedStaffResponse = await searchAs('staff-b', 'Search');
    expect(unrelatedStaffResponse.status).toBe(200);
    expect(canViewFor(unrelatedStaffResponse)).toBe(false);

    const unrelatedManagerResponse = await searchAs('manager-b', 'Search');
    expect(unrelatedManagerResponse.status).toBe(200);
    expect(canViewFor(unrelatedManagerResponse)).toBe(false);
  });

  it('blocks getLeadById for unauthorized users', async () => {
    const staffBToken = await login('staff-b');
    const denied = await request(app)
      .get(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${staffBToken}`);
    expect(denied.status).toBe(403);

    const managerAToken = await login('manager-a');
    const allowed = await request(app)
      .get(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${managerAToken}`);
    expect(allowed.status).toBe(200);
  });

  it('keeps legacy filter searchTerm behavior for older clients', async () => {
    const staffBToken = await login('staff-b');
    const legacy = await request(app)
      .post('/api/leads/filter')
      .set('Authorization', `Bearer ${staffBToken}`)
      .send({ searchTerm: 'Search', skip: '0', limit: '20' });

    expect(legacy.status).toBe(200);
    expect(legacy.body.leads.some((item: { _id: string }) => item._id === leadId)).toBe(true);
    expect(legacy.body.leads[0].canViewDetails).toBeUndefined();
  });
});
