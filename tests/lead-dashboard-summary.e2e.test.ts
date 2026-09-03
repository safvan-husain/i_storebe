import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: {
    sign: (payload: unknown) => `mock.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
    verify: (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')),
  },
}));
jest.mock('firebase-admin/app', () => ({ __esModule: true, initializeApp: jest.fn() }));
jest.mock('firebase-admin', () => ({ __esModule: true, credential: { cert: jest.fn() } }));
jest.mock('../src/services/wish-birth-day', () => ({ __esModule: true, wishBirthDayToCustomers: jest.fn() }));
jest.mock('../src/services/task-scheduler', () => ({ __esModule: true, startTaskScheduler: jest.fn() }));
jest.mock('../src/services/notification-services', () => ({
  __esModule: true,
  createNotificationForUsers: jest.fn(),
  getNotifications: jest.fn(),
  sendPushNotification: jest.fn(),
}));

import app from '../src/server';
import User from '../src/models/User';
import Customer from '../src/models/Customer';
import Lead from '../src/models/Lead';
import { getLeadDashboardSummaryDateRanges } from '../src/controllers/leads/leadController';

jest.setTimeout(60000);

describe('lead dashboard summary', () => {
  let mongo: MongoMemoryServer;

  const login = async (username: string) => {
    const response = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
    expect(response.status).toBe(200);
    return response.body.token as string;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'lead-dashboard-summary-e2e' });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await User.create([
      { username: 'admin', password: 'password123', privilege: 'admin', secondPrivilege: 'regular', isActive: true, isAccountDeleted: false },
      { username: 'manager', password: 'password123', privilege: 'manager', secondPrivilege: 'regular', isActive: true, isAccountDeleted: false },
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('returns unfiltered company-wide counts using IST Sunday-to-Saturday boundaries', async () => {
    const admin = await User.findOne({ username: 'admin' }).lean();
    const { todayStart, tomorrowStart, weekStart, nextWeekStart, monthStart, nextMonthStart } =
      getLeadDashboardSummaryDateRanges();
    const dates = [
      new Date(todayStart.getTime() + 60 * 60 * 1000),
      new Date(weekStart.getTime() + 60 * 60 * 1000),
      new Date(monthStart.getTime() + 60 * 60 * 1000),
      new Date(monthStart.getTime() - 60 * 60 * 1000),
    ];
    const customers = await Customer.create(dates.map((_, index) => ({ name: `Customer ${index}`, phone: `900000000${index}` })));
    await Lead.create(dates.map((createdAt, index) => ({
      source: 'call', enquireStatus: 'new', purpose: 'purchase', type: 'fresh', product: 'Phone',
      createdBy: admin!._id, manager: admin!._id, handledBy: admin!._id, customer: customers[index]._id,
      createdAt, updatedAt: createdAt,
    })));

    const countBetween = (start: Date, end: Date) => dates.filter((date) => date >= start && date < end).length;
    const response = await request(app)
      .get('/api/leads/dashboard-summary')
      .set('Authorization', `Bearer ${await login('admin')}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      totalCount: dates.length,
      todayCount: countBetween(todayStart, tomorrowStart),
      weekCount: countBetween(weekStart, nextWeekStart),
      monthCount: countBetween(monthStart, nextMonthStart),
    });
  });

  it('rejects non-admin accounts', async () => {
    const response = await request(app)
      .get('/api/leads/dashboard-summary')
      .set('Authorization', `Bearer ${await login('manager')}`);

    expect(response.status).toBe(403);
  });

  it('builds IST boundaries at midnight, Sunday, and month rollover', () => {
    const ranges = getLeadDashboardSummaryDateRanges(new Date('2026-08-01T20:00:00.000Z'));
    expect(ranges.todayStart.toISOString()).toBe('2026-08-01T18:30:00.000Z');
    expect(ranges.weekStart.toISOString()).toBe('2026-08-01T18:30:00.000Z');
    expect(ranges.monthStart.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(ranges.nextMonthStart.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });
});
