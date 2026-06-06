import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mockPdfHtml = '';

type SeededFixture = {
  managerA: { _id: Types.ObjectId };
  managerB: { _id: Types.ObjectId };
  staffA: { _id: Types.ObjectId };
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
        pdf: jest.fn(async () => Buffer.from('%PDF activity report')),
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

describe('Activity report export access', () => {
  let mongo: MongoMemoryServer;
  let seeded: SeededFixture;

  const seedUsersAndBranches = async () => {
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
        username: 'manager-b',
        password: 'password123',
        privilege: 'manager',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
      {
        username: 'manager-no-branch',
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

    const byName = new Map(users.map(user => [user.username, user]));
    const admin = byName.get('admin')!;
    const managerA = byName.get('manager-a')!;
    const managerB = byName.get('manager-b')!;
    const staffA = byName.get('staff-a')!;
    const staffB = byName.get('staff-b')!;

    await User.findByIdAndUpdate(staffA._id, { manager: managerA._id });
    await User.findByIdAndUpdate(staffB._id, { manager: managerB._id });

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
      manager: managerB._id,
      staffs: [staffB._id],
      isActive: true,
      createdBy: admin._id,
    });

    await BranchMembership.create([
      { branch: branchA._id, user: managerA._id, role: 'manager', startedAt: new Date('2026-01-01') },
      { branch: branchA._id, user: staffA._id, role: 'staff', startedAt: new Date('2026-01-01') },
      { branch: branchB._id, user: managerB._id, role: 'manager', startedAt: new Date('2026-01-01') },
      { branch: branchB._id, user: staffB._id, role: 'staff', startedAt: new Date('2026-01-01') },
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
        activator: staffB._id,
        actorBranch: branchB._id,
        type: 'lead_added',
        action: 'staff-b created a lead',
        createdAt: new Date('2026-05-01'),
      },
    ]);

    return { managerA, managerB, staffA, branchA, branchB };
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
      dbName: 'activity-report-e2e',
    });
  });

  beforeEach(async () => {
    mockPdfHtml = '';
    await mongoose.connection.db!.dropDatabase();
    seeded = await seedUsersAndBranches();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('requires authentication for activity report exports', async () => {
    const response = await request(app).get('/api/activity/statics');

    expect(response.status).toBe(401);
  });

  it('rejects staff activity report exports', async () => {
    const token = await login('staff-a');

    const response = await request(app)
      .get('/api/activity/statics')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it('allows admins to export a branch report', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/statics')
      .query({ branch: String(seeded.branchA._id) })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(mockPdfHtml).toContain('staff-a');
    expect(mockPdfHtml).not.toContain('staff-b');
  });

  it('allows admins to export a manager report with date filters', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/statics')
      .query({
        manager: String(seeded.managerA._id),
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(mockPdfHtml).toContain('staff-a');
    expect(mockPdfHtml).not.toContain('staff-b');
  });

  it('forces managers to their own branch even when manager or staff filters are supplied', async () => {
    const token = await login('manager-a');

    const response = await request(app)
      .get('/api/activity/statics')
      .query({
        manager: String(seeded.managerB._id),
        staff: String(seeded.staffA._id),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('manager-a');
    expect(mockPdfHtml).toContain('staff-a');
    expect(mockPdfHtml).not.toContain('manager-b');
    expect(mockPdfHtml).not.toContain('staff-b');
  });

  it('rejects manager requests for another branch', async () => {
    const token = await login('manager-a');

    const response = await request(app)
      .get('/api/activity/statics')
      .query({ branch: String(seeded.branchB._id) })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it('returns a clear error when a manager has no current branch', async () => {
    const token = await login('manager-no-branch');

    const response = await request(app)
      .get('/api/activity/statics')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('No active branch found for this manager');
  });
});
