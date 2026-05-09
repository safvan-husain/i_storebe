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

jest.setTimeout(60000);

describe('Attendance endpoints e2e', () => {
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
        username: 'staff-one',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
      },
    ]);

    const admin = await User.findOne({ username: 'admin' }).select('_id').lean();
    const manager = await User.findOne({ username: 'manager-a' }).select('_id').lean();
    const staff = await User.findOne({ username: 'staff-one' }).select('_id').lean();

    expect(admin).toBeTruthy();
    expect(manager).toBeTruthy();
    expect(staff).toBeTruthy();

    const branch = await Branch.create({
      name: 'Dubai Main',
      normalizedName: 'dubai-main',
      timezone: 'Asia/Dubai',
      manager: manager!._id,
      staffs: [staff!._id],
      createdBy: admin!._id,
      isActive: true,
    });

    await User.findByIdAndUpdate(staff!._id, { manager: manager!._id });

    return {
      adminId: String(admin!._id),
      managerId: String(manager!._id),
      staffId: String(staff!._id),
      branchId: String(branch._id),
    };
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

  const createAttendanceSetup = async (adminToken: string, seed: Awaited<ReturnType<typeof seedUsers>>) => {
    const shift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Full Day',
        startTime: '09:00',
        endTime: '17:00',
        requiredWorkMinutes: 420,
        graceLateMinutes: 10,
        graceEarlyLeaveMinutes: 10,
        isActive: true,
      });
    expect(shift.status).toBe(201);

    const privilege = await request(app)
      .post('/api/attendance/privileges')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Prayer Break',
        description: 'Allows prayer break subtypes.',
        isActive: true,
      });
    expect(privilege.status).toBe(201);

    const employeePrivileges = await request(app)
      .put(`/api/attendance/employees/${seed.staffId}/privileges`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        privilegeIds: [privilege.body._id],
      });
    expect(employeePrivileges.status).toBe(200);

    const breakType = await request(app)
      .post('/api/attendance/break-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Prayer',
        privilegeIds: [privilege.body._id],
        maxMinutesPerDay: 75,
        isActive: true,
      });
    expect(breakType.status).toBe(201);

    const breakSubtype = await request(app)
      .post(`/api/attendance/break-types/${breakType.body._id}/subtypes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dhuhr',
        inheritsParentPrivilege: true,
        windowStart: '12:00',
        windowEnd: '14:00',
        maxMinutesPerEvent: 15,
        maxEventsPerDay: 1,
        isActive: true,
      });
    expect(breakSubtype.status).toBe(201);

    const template = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Standard Week',
        type: 'weekly',
        weeklyPattern: {
          monday: [shift.body._id],
          tuesday: [shift.body._id],
          wednesday: [shift.body._id],
          thursday: [shift.body._id],
          friday: [shift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: true,
      });
    expect(template.status).toBe(201);

    const branchAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: template.body._id,
        targetType: 'branch',
        branchId: seed.branchId,
        effectiveFrom: '2026-05-01',
      });
    expect(branchAssignment.status).toBe(201);

    return {
      shiftId: shift.body._id as string,
      privilegeId: privilege.body._id as string,
      breakTypeId: breakType.body._id as string,
      breakSubtypeId: breakSubtype.body._id as string,
      templateId: template.body._id as string,
      branchAssignmentId: branchAssignment.body._id as string,
    };
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'attendance-e2e',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('allows admin to configure shifts, breaks, privileges, weekly templates, and branch assignments', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const shift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Full Day',
        startTime: '09:00',
        endTime: '17:00',
        requiredWorkMinutes: 420,
        graceLateMinutes: 10,
        graceEarlyLeaveMinutes: 10,
        isActive: true,
      });

    expect(shift.status).toBe(201);
    expect(shift.body).toMatchObject({
      name: 'Full Day',
      startTime: '09:00',
      endTime: '17:00',
      requiredWorkMinutes: 420,
    });

    const privilege = await request(app)
      .post('/api/attendance/privileges')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Prayer Break',
        description: 'Allows prayer break subtypes.',
        isActive: true,
      });

    expect(privilege.status).toBe(201);

    const employeePrivileges = await request(app)
      .put(`/api/attendance/employees/${seed.staffId}/privileges`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        privilegeIds: [privilege.body._id],
      });

    expect(employeePrivileges.status).toBe(200);
    expect(employeePrivileges.body.privilegeIds).toContain(privilege.body._id);

    const breakType = await request(app)
      .post('/api/attendance/break-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Prayer',
        privilegeIds: [privilege.body._id],
        maxMinutesPerDay: 75,
        isActive: true,
      });

    expect(breakType.status).toBe(201);
    expect(breakType.body).not.toHaveProperty('paid');
    expect(breakType.body).not.toHaveProperty('requiresApproval');

    const breakSubtype = await request(app)
      .post(`/api/attendance/break-types/${breakType.body._id}/subtypes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dhuhr',
        inheritsParentPrivilege: true,
        windowStart: '12:00',
        windowEnd: '14:00',
        maxMinutesPerEvent: 15,
        maxEventsPerDay: 1,
        isActive: true,
      });

    expect(breakSubtype.status).toBe(201);

    const template = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Standard Week',
        type: 'weekly',
        weeklyPattern: {
          monday: [shift.body._id],
          tuesday: [shift.body._id],
          wednesday: [shift.body._id],
          thursday: [shift.body._id],
          friday: [shift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: true,
      });

    expect(template.status).toBe(201);

    const branchAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: template.body._id,
        targetType: 'branch',
        branchId: seed.branchId,
        effectiveFrom: '2026-05-01',
      });

    expect(branchAssignment.status).toBe(201);
    expect(branchAssignment.body).toMatchObject({
      targetType: 'branch',
      branchId: seed.branchId,
    });
  });

  it('blocks manager and staff from attendance configuration endpoints', async () => {
    await seedUsers();
    const managerToken = await login('manager-a');
    const staffToken = await login('staff-one');

    const managerShiftAttempt = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        name: 'Manager Shift',
        startTime: '09:00',
        endTime: '17:00',
        requiredWorkMinutes: 420,
      });

    expect(managerShiftAttempt.status).toBe(403);

    const staffAssignmentAttempt = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        templateId: new mongoose.Types.ObjectId().toString(),
        targetType: 'global',
        effectiveFrom: '2026-05-01',
      });

    expect(staffAssignmentAttempt.status).toBe(403);
  });

  it('rejects employee-list schedule assignments because v1 supports only global and branch targets', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const response = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: new mongoose.Types.ObjectId().toString(),
        targetType: 'employees',
        employeeIds: [seed.staffId],
        effectiveFrom: '2026-05-01',
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/global|branch|target/i);
  });

  it('allows admins to assign working-shift memberships and create day overrides', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const salesShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Sales Standard Week',
        weeklyPattern: {
          monday: { startTime: '09:00', endTime: '17:00', requiredWorkMinutes: 420 },
          tuesday: { startTime: '09:00', endTime: '17:00', requiredWorkMinutes: 420 },
          wednesday: { startTime: '09:00', endTime: '17:00', requiredWorkMinutes: 420 },
          thursday: { startTime: '09:00', endTime: '17:00', requiredWorkMinutes: 420 },
          friday: { startTime: '09:00', endTime: '13:00', requiredWorkMinutes: 210 },
          saturday: null,
          sunday: null,
        },
        graceLateMinutes: 10,
        graceEarlyLeaveMinutes: 10,
      });
    expect(salesShift.status).toBe(201);
    expect(salesShift.body.version).toBe(1);
    expect(salesShift.body.weeklyPattern.friday).toMatchObject({
      startTime: '09:00',
      endTime: '13:00',
      requiredWorkMinutes: 210,
    });

    const membership = await request(app)
      .post('/api/attendance/shift-memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        shiftId: salesShift.body._id,
        branchId: seed.branchId,
        employeeIds: [seed.staffId],
      });
    expect(membership.status).toBe(201);
    expect(membership.body.items).toHaveLength(1);
    expect(membership.body.items[0]).toMatchObject({
      shift: salesShift.body._id,
      employee: seed.staffId,
      branch: seed.branchId,
      status: 'active',
    });

    const conflictShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Late Week',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(conflictShift.status).toBe(201);

    const conflict = await request(app)
      .post('/api/attendance/shift-memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        shiftId: conflictShift.body._id,
        branchId: seed.branchId,
        employeeIds: [seed.staffId],
      });
    expect(conflict.status).toBe(409);

    const replaced = await request(app)
      .post('/api/attendance/shift-memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        shiftId: conflictShift.body._id,
        branchId: seed.branchId,
        employeeIds: [seed.staffId],
        replaceExisting: true,
      });
    expect(replaced.status).toBe(201);
    expect(replaced.body.items[0].shift).toBe(conflictShift.body._id);

    const shiftOverride = await request(app)
      .post('/api/attendance/shift-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'shift',
        branchId: seed.branchId,
        shiftId: conflictShift.body._id,
        date: '2099-05-04',
        overrideType: 'hours',
        startTime: '11:00',
        endTime: '19:00',
        requiredWorkMinutes: 420,
        note: 'Branch meeting day',
      });
    expect(shiftOverride.status).toBe(201);

    const resolvedShiftOverride = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolvedShiftOverride.status).toBe(200);
    expect(resolvedShiftOverride.body).toMatchObject({
      source: 'shift_membership',
      scheduledStart: '11:00',
      scheduledEnd: '19:00',
      requiredWorkMinutes: 420,
      overrideType: 'hours',
    });

    const employeeOverride = await request(app)
      .post('/api/attendance/shift-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'employee',
        branchId: seed.branchId,
        employeeId: seed.staffId,
        date: '2099-05-04',
        overrideType: 'off_day',
        note: 'Approved admin exception',
      });
    expect(employeeOverride.status).toBe(201);

    const resolvedEmployeeOverride = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolvedEmployeeOverride.status).toBe(200);
    expect(resolvedEmployeeOverride.body).toMatchObject({
      source: 'shift_membership',
      requiredWorkMinutes: 0,
      overrideType: 'off_day',
    });
    expect(resolvedEmployeeOverride.body.scheduledSegments).toEqual([]);
  });

  it('resolves branch assignment before global assignment for staff expected schedule', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);

    const response = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2026-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      employeeId: seed.staffId,
      branchId: seed.branchId,
      source: 'branch',
      branchTimezone: 'Asia/Dubai',
    });
  });

  it('allows staff to check in before scheduled start, take a break, and checkout with productive time totals', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T04:45:00.000Z',
      });

    expect(checkIn.status).toBe(201);
    expect(checkIn.body).toMatchObject({
      type: 'check_in',
      branchLocalDate: '2026-05-04',
      branchLocalTime: '08:45',
      branchTimezone: 'Asia/Dubai',
    });

    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2026-05-04T09:00:00.000Z',
      });

    expect(breakStart.status).toBe(201);
    expect(breakStart.body.type).toBe('break_start');

    const breakEnd = await request(app)
      .post('/api/attendance/events/break-end')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T09:10:00.000Z',
      });

    expect(breakEnd.status).toBe(201);
    expect(breakEnd.body.type).toBe('break_end');

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T13:30:00.000Z',
      });

    expect(checkout.status).toBe(201);
    expect(checkout.body.snapshot).toMatchObject({
      grossMinutes: 525,
      totalBreakMinutes: 10,
      productiveWorkMinutes: 515,
      overtimeMinutes: 95,
      undertimeMinutes: 0,
    });
    expect(checkout.body.snapshot.breakTotals[0]).toEqual(
      expect.objectContaining({
        minutes: 10,
        allowedMinutes: expect.any(Number),
        unusedAllowedMinutes: expect.any(Number),
        overtimeMinutes: expect.any(Number),
        undertimeMinutes: 0,
      })
    );
  });

  it('stores break-related undertime when break duration exceeds the configured allowance', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T05:00:00.000Z',
      });
    expect(checkIn.status).toBe(201);

    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2026-05-04T09:00:00.000Z',
      });
    expect(breakStart.status).toBe(201);

    const breakEnd = await request(app)
      .post('/api/attendance/events/break-end')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T09:30:00.000Z',
      });
    expect(breakEnd.status).toBe(201);

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T13:00:00.000Z',
      });

    expect(checkout.status).toBe(201);
    expect(checkout.body.snapshot).toEqual(
      expect.objectContaining({
        totalBreakMinutes: expect.any(Number),
        productiveWorkMinutes: expect.any(Number),
        breakUndertimeMinutes: 15,
      })
    );
    expect(checkout.body.snapshot.breakTotals[0]).toEqual(
      expect.objectContaining({
        excessMinutes: 15,
        undertimeMinutes: 15,
      })
    );
  });

  it('prevents invalid attendance transitions', async () => {
    await seedUsers();
    const staffToken = await login('staff-one');

    const breakBeforeCheckIn = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        breakTypeId: new mongoose.Types.ObjectId().toString(),
      });

    expect(breakBeforeCheckIn.status).toBe(409);

    const checkoutBeforeCheckIn = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});

    expect(checkoutBeforeCheckIn.status).toBe(409);
  });

  it('generates missing checkout snapshots and requires admin correction', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2026-05-04T05:00:00.000Z',
      });

    expect(checkIn.status).toBe(201);

    const finalize = await request(app)
      .post('/api/attendance/jobs/finalize-daily-snapshots')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        branchId: seed.branchId,
        date: '2026-05-04',
      });

    expect(finalize.status).toBe(200);
    expect(finalize.body.createdSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employee: seed.staffId,
          status: 'missing_checkout',
          generatedBy: 'scheduled_job',
        }),
      ])
    );

    const staffCorrectionAttempt = await request(app)
      .post(`/api/attendance/daily-snapshots/${finalize.body.createdSnapshots[0]._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        checkoutTime: '17:30',
        reason: 'Forgot checkout',
      });

    expect(staffCorrectionAttempt.status).toBe(403);

    const adminCorrection = await request(app)
      .post(`/api/attendance/daily-snapshots/${finalize.body.createdSnapshots[0]._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '17:30',
        reason: 'Staff forgot checkout; admin verified.',
      });

    expect(adminCorrection.status).toBe(200);
    expect(adminCorrection.body.snapshot).toMatchObject({
      status: 'present',
      generatedBy: 'correction',
      lastCheckOut: '17:30',
    });
    expect(adminCorrection.body.snapshot.version).toBeGreaterThan(1);
  });

  it('allows managers to view scoped team attendance but not mutate records', async () => {
    await seedUsers();
    const managerToken = await login('manager-a');

    const teamSnapshots = await request(app)
      .get('/api/attendance/team/daily-snapshots')
      .query({ date: '2026-05-04' })
      .set('Authorization', `Bearer ${managerToken}`);

    expect(teamSnapshots.status).toBe(200);
    expect(Array.isArray(teamSnapshots.body.items)).toBe(true);

    const correctionAttempt = await request(app)
      .post(`/api/attendance/daily-snapshots/${new mongoose.Types.ObjectId().toString()}/corrections/checkout`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        checkoutTime: '17:30',
        reason: 'Manager correction attempt',
      });

    expect(correctionAttempt.status).toBe(403);
  });

  it('allows staff to view only their own daily summary', async () => {
    const seed = await seedUsers();
    const staffToken = await login('staff-one');

    const ownSummary = await request(app)
      .get('/api/attendance/me/daily-snapshots')
      .query({ date: '2026-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(ownSummary.status).toBe(200);

    const otherEmployeeSummary = await request(app)
      .get(`/api/attendance/employees/${seed.managerId}/daily-snapshots`)
      .query({ date: '2026-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(otherEmployeeSummary.status).toBe(403);
  });
});
