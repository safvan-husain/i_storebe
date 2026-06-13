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
        pdf: jest.fn(async () => Buffer.from('%PDF person activity report')),
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
import Customer from '../src/models/Customer';
import Lead from '../src/models/Lead';
import Task from '../src/models/Task';

jest.setTimeout(60000);

const extractTotalsRow = (html: string) => {
  const match = html.match(/<tr class="totals-row">([\s\S]*?)<\/tr>/);
  if (!match) return [];
  return [...match[1].matchAll(/<td><strong>(\d+)<\/strong><\/td>/g)].map(item => Number(item[1]));
};

describe('Person activity report export', () => {
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
      staffs: [staffB._id, staffTransferred._id],
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
        activator: staffTransferred._id,
        actorBranch: branchA._id,
        type: 'lead_added',
        action: 'staff-transferred created a lead in branch A',
        createdAt: new Date('2026-05-15'),
      },
      {
        activator: staffTransferred._id,
        actorBranch: branchB._id,
        type: 'lead_added',
        action: 'staff-transferred created a lead in branch B',
        createdAt: new Date('2026-06-10'),
      },
      {
        activator: staffTransferred._id,
        actorBranch: branchA._id,
        type: 'task_added',
        action: 'staff-transferred added a task in branch A',
        createdAt: new Date('2026-01-15'),
      },
    ]);

    const customer = await Customer.create({
      name: 'Task Customer',
      phone: '8888888888',
    });

    await Task.create({
      lead: (await Lead.create({
        source: 'walkin',
        enquireStatus: 'new',
        purpose: 'purchase',
        type: 'fresh',
        product: 'phone',
        createdBy: staffTransferred._id,
        manager: managerA._id,
        handledBy: staffTransferred._id,
        customer: customer._id,
        createdBranch: branchA._id,
        handlingBranch: branchA._id,
        createdAt: new Date('2026-01-01'),
      }))._id,
      title: 'Pending task',
      description: 'Pending task',
      category: 'call',
      assigned: staffTransferred._id,
      isCompleted: false,
      due: new Date('2020-01-01'),
      createdAt: new Date('2026-01-01'),
    });

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
      dbName: 'activity-person-report-e2e',
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
    const response = await request(app).get('/api/activity/reports/person');
    expect(response.status).toBe(401);
  });

  it('rejects staff and manager exports', async () => {
    const staffToken = await login('staff-a');
    const managerToken = await login('manager-a');

    const staffResponse = await request(app)
      .get('/api/activity/reports/person')
      .query({ userId: String(seeded.staffTransferred._id) })
      .set('Authorization', `Bearer ${staffToken}`);
    const managerResponse = await request(app)
      .get('/api/activity/reports/person')
      .query({ userId: String(seeded.staffTransferred._id) })
      .set('Authorization', `Bearer ${managerToken}`);

    expect(staffResponse.status).toBe(403);
    expect(managerResponse.status).toBe(403);
  });

  it('shows branch stints and transfer note when transfer is inside the range', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/person')
      .query({
        userId: String(seeded.staffTransferred._id),
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-06-30T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('Activity Report — staff-transferred');
    expect(mockPdfHtml).toContain('Person: staff-transferred');
    expect(mockPdfHtml).toContain('<th>Branch</th>');
    expect(mockPdfHtml).toContain('<th>Period</th>');
    expect(mockPdfHtml).toContain('<th>Role</th>');
    expect(mockPdfHtml).toContain('Branch A');
    expect(mockPdfHtml).toContain('Branch B');
    expect(mockPdfHtml).toContain('Transferred from Branch A to Branch B');
    expect(mockPdfHtml).toContain('Combined Total (all branches)');
  });

  it('shows only the new branch stint when transfer happened before the range', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/person')
      .query({
        userId: String(seeded.staffTransferred._id),
        startDate: String(new Date('2026-06-10T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-06-30T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('Branch B');
    expect(mockPdfHtml).not.toContain('Branch A');
    expect(mockPdfHtml).not.toContain('Transferred from');
  });

  it('shows zero-activity membership stints', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/person')
      .query({
        userId: String(seeded.staffA._id),
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-05-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('Branch A');
    expect(mockPdfHtml).toContain('Combined Total (all branches)');
  });

  it('shows historical activity when membership startedAt predates branch provisioning', async () => {
    const token = await login('admin');

    const admin = await User.findOne({ username: 'admin' });
    const staffHistorical = await User.create({
      username: 'staff-historical',
      password: 'password123',
      privilege: 'staff',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
      createdAt: new Date('2025-04-28T00:00:00.000Z'),
    });
    const branchHistorical = await Branch.create({
      name: 'Branch Historical',
      normalizedName: 'branch historical',
      timezone: 'Asia/Dubai',
      manager: seeded.managerA._id,
      staffs: [staffHistorical._id],
      isActive: true,
      createdBy: admin!._id,
      createdAt: new Date('2026-04-26T05:42:54.027Z'),
    });
    await BranchMembership.create({
      branch: branchHistorical._id,
      user: staffHistorical._id,
      role: 'staff',
      startedAt: new Date('2025-04-28T00:00:00.000Z'),
    });
    await Activity.create({
      activator: staffHistorical._id,
      actorBranch: branchHistorical._id,
      type: 'lead_added',
      action: 'historical lead before branch provisioning',
      createdAt: new Date('2025-05-15T00:00:00.000Z'),
    });

    const response = await request(app)
      .get('/api/activity/reports/person')
      .query({
        userId: String(staffHistorical._id),
        startDate: String(new Date('2025-01-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-12-31T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('Branch Historical');
    expect(mockPdfHtml).toContain('<td>1</td>');

    const totals = extractTotalsRow(mockPdfHtml);
    expect(totals[1]).toBe(1);
  });

  it('sums branch rows in combined total including branch-scoped pending tasks', async () => {
    const token = await login('admin');

    const response = await request(app)
      .get('/api/activity/reports/person')
      .query({
        userId: String(seeded.staffTransferred._id),
        startDate: String(new Date('2026-05-01T00:00:00.000Z').getTime()),
        endDate: String(new Date('2026-06-30T00:00:00.000Z').getTime()),
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockPdfHtml).toContain('Combined Total (all branches)');
    expect(mockPdfHtml).toContain("linked lead's handling branch matches");

    const branchARow = mockPdfHtml.match(
      /<tr>\s*<td>Branch A<\/td>[\s\S]*?<\/tr>/,
    )?.[0];
    expect(branchARow).toBeDefined();
    expect(branchARow).toContain('<td>1</td>');
    expect(branchARow).toMatch(/<td>1<\/td>.*<td>1<\/td>\s*<\/tr>/);

    const totals = extractTotalsRow(mockPdfHtml);
    expect(totals[0]).toBe(0);
    expect(totals[1]).toBe(2);
    expect(totals[2]).toBe(1);
    expect(totals[6]).toBe(1);
  });
});
