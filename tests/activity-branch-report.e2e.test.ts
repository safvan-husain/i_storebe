import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mockPdfHtml = '';

type SeededFixture = {
  managerA: { _id: Types.ObjectId };
  staffA: { _id: Types.ObjectId };
  staffTransferred: { _id: Types.ObjectId };
  staffInactive: { _id: Types.ObjectId };
  branchA: { _id: Types.ObjectId };
  branchB: { _id: Types.ObjectId };
};

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

jest.mock('puppeteer', () => ({
  __esModule: true,
  default: {
    launch: jest.fn(async () => ({
      newPage: jest.fn(async () => ({
        setContent: jest.fn(async (html: string) => {
          mockPdfHtml = html;
        }),
        pdf: jest.fn(async () => Buffer.from('%PDF branch activity report')),
      })),
      close: jest.fn(async () => undefined),
    })),
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
import Activity from '../src/models/Activity';

jest.setTimeout(60000);

const extractTotalsRow = (html: string) => {
  const match = html.match(/<tr class="totals-row">([\s\S]*?)<\/tr>/);
  if (!match) return [];
  return [...match[1].matchAll(/<td><strong>(\d+)<\/strong><\/td>/g)].map(item => Number(item[1]));
};

describe('Branch activity report export', () => {
  let mongo: MongoMemoryServer;
  let seeded: SeededFixture;

  const seedFixture = async () => {
    const users = await User.create([
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
        username: 'staff-a',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'staff-transferred',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'staff-inactive',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: false,
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

    const byName = new Map(users.map(user => [user.username, user]));
    const admin = byName.get('admin')!;
    const managerA = byName.get('manager-a')!;
    const staffA = byName.get('staff-a')!;
    const staffTransferred = byName.get('staff-transferred')!;
    const staffInactive = byName.get('staff-inactive')!;
    const staffB = byName.get('staff-b')!;

    await User.findByIdAndUpdate(staffA._id, { manager: managerA._id });
    await User.findByIdAndUpdate(staffTransferred._id, { manager: managerA._id });
    await User.findByIdAndUpdate(staffInactive._id, { manager: managerA._id });
    await User.findByIdAndUpdate(staffB._id, { manager: managerA._id });

    const branchA = await Branch.create({
      name: 'Branch A',
      normalizedName: 'branch a',
      timezone: 'Asia/Dubai',
      manager: managerA._id,
      staffs: [staffA._id],
      isActive: true,
      createdBy: admin._id,
    });
    const branchB = await Branch.create({
      name: 'Branch B',
      normalizedName: 'branch b',
      timezone: 'Asia/Dubai',
      manager: managerA._id,
      staffs: [staffB._id],
      isActive: true,
      createdBy: admin._id,
    });

    await BranchMembership.create([
      {
        branch: branchA._id,
        user: managerA._id,
        role: 'manager',
        startedAt: new Date('2026-01-01'),
      },
      {
        branch: branchA._id,
        user: staffA._id,
        role: 'staff',
        startedAt: new Date('2026-01-01'),
      },
      {
        branch: branchA._id,
        user: staffTransferred._id,
        role: 'staff',
        startedAt: new Date('2026-01-01'),
        endedAt: new Date('2026-06-01'),
        endReason: 'transferred',
      },
      {
        branch: branchB._id,
        user: staffTransferred._id,
        role: 'staff',
        startedAt: new Date('2026-06-02'),
      },
      {
        branch: branchA._id,
        user: staffInactive._id,
        role: 'staff',
        startedAt: new Date('2026-01-01'),
        endedAt: new Date('2026-07-01'),
        endReason: 'removed',
      },
      {
        branch: branchB._id,
        user: staffB._id,
        role: 'staff',
        startedAt: new Date('2026-01-01'),
      },
    ]);

    await Activity.create([
      {
        activator: staffA._id,
        actorBranch: branchA._id,
        type: 'lead_added',
        action: 'staff-a created a lead',
        createdAt: new Date('2026-05-01'),
      },
      {
        activator: staffTransferred._id,
        actorBranch: branchA._id,
        type: 'lead_added',
        action: 'staff-transferred created a lead',
        createdAt: new Date('2026-05-15'),
      },
      {
        activator: staffB._id,
        actorBranch: branchB._id,
        type: 'lead_added',
        action: 'staff-b created a lead',
        createdAt: new Date('2026-05-01'),
      },
    ]);

    return { managerA, staffA, staffTransferred, staffInactive, branchA, branchB };
  };

  const login = async (username: string) => {
    const response = await request(app).post('/api/auth/login').send({
      username,
      password: 'password123',
    });

    expect(response.status).toBe(200);
    return response.body.token as string;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'activity-branch-report-e2e',
    });
  });

  beforeEach(async () => {
    mockPdfHtml = '';
    await mongoose.connection.db!.dropDatabase();
    seeded = await seedFixture();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/activity/reports/branch');
    expect(response.status).toBe(401);
  });

  it('rejects staff and manager exports', async () => {
    const staffToken = await login('staff-a');
    const managerToken = await login('manager-a');

    const staffResponse = await request(app)
      .get('/api/activity/reports/branch')
      .set('Authorization', `Bearer ${staffToken}`);
    const managerResponse = await request(app)
      .get('/api/activity/reports/branch')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(staffResponse.status).toBe(403);
    expect(managerResponse.status).toBe(403);
  });

  it('exports active branch roster by default', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({ branch: String(seeded.branchA._id) })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('staff-a');
    expect(mockPdfHtml).not.toContain('staff-transferred');
    expect(mockPdfHtml).toContain('TOTAL');
  });

  it('hides transferred staff from breakdown but keeps their counts in TOTAL when flag is off', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({
        branch: String(seeded.branchA._id),
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).not.toContain('staff-transferred');

    const totals = extractTotalsRow(mockPdfHtml);
    expect(totals[1]).toBe(2);
  });

  it('shows transferred staff with annotation when includeInactiveUsers is true', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({
        branch: String(seeded.branchA._id),
        includeInactiveUsers: 'true',
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('staff-transferred (transferred)');
    expect(mockPdfHtml).toContain('staff-a');
  });

  it('does not show inactive users with zero counts even when includeInactiveUsers is true', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({
        branch: String(seeded.branchA._id),
        includeInactiveUsers: 'true',
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).not.toContain('staff-inactive');
  });

  it('exports all-branches branch summary by default', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('Branch A');
    expect(mockPdfHtml).toContain('Branch B');
    expect(mockPdfHtml).toContain('Activity Summary by Branch');
    expect(mockPdfHtml).not.toContain('staff-a');
    expect(mockPdfHtml).toContain('TOTAL');
  });

  it('exports all-branches staff breakdown when groupBy is staff', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({
        groupBy: 'staff',
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('staff-a');
    expect(mockPdfHtml).toContain('staff-b');
    expect(mockPdfHtml).toContain('Activity Summary');
    expect(mockPdfHtml).not.toContain('Activity Summary by Branch');
  });

  it('rejects branch summary for a single branch export', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/branch')
      .query({
        branch: String(seeded.branchA._id),
        groupBy: 'branch',
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(400);
  });
});
