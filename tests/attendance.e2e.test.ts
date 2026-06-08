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
import AttendanceDailySnapshot from '../src/models/AttendanceDailySnapshot';
import FileDocument from '../src/models/FileDocument';

jest.setTimeout(60000);

describe('Attendance endpoints e2e', () => {
  let mongo: MongoMemoryServer;
  const faceVector = Array.from({ length: 128 }, (_, index) => index / 128);
  const branchLatitude = 25.2048;
  const branchLongitude = 55.2708;
  const validAttendanceLocation = {
    location: {
      latitude: branchLatitude,
      longitude: branchLongitude,
      accuracyMeters: 20,
    },
  };

  const seedUsers = async () => {
    const staffProfileImage = await FileDocument.create({
      fileName: 'staff-one.jpg',
      path: 'uploads/users/staff-one.jpg',
      mimeType: 'image/jpeg',
      size: 123,
    });

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
        profileImageFile: staffProfileImage._id,
        faceEmbedding: faceVector,
        faceEmbeddingModel: 'face_embedder.tflite',
        faceEmbeddingUpdatedAt: new Date(),
        faceEmbeddingSourceImage: staffProfileImage._id,
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
      location: {
        latitude: branchLatitude,
        longitude: branchLongitude,
        updatedAt: new Date(),
        updatedBy: admin!._id,
      },
      createdBy: admin!._id,
      isActive: true,
      attendanceEnabled: true,
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
        effectiveFrom: '2099-05-01',
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
        effectiveFrom: '2099-05-01',
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

    const managerGroupAttempt = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        name: 'Manager Group',
        branchId: new mongoose.Types.ObjectId().toString(),
        isActive: true,
      });

    expect(managerGroupAttempt.status).toBe(403);

    const staffAssignmentAttempt = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        templateId: new mongoose.Types.ObjectId().toString(),
        targetType: 'global',
        effectiveFrom: '2099-05-01',
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
        effectiveFrom: '2099-05-01',
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/global|branch|target/i);
  });

  it('allows admin to deactivate a global schedule assignment', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const setup = await createAttendanceSetup(adminToken, seed);
    const globalAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: setup.templateId,
        targetType: 'global',
        effectiveFrom: '2099-05-01',
      });
    expect(globalAssignment.status).toBe(201);

    const deactivated = await request(app)
      .patch(`/api/attendance/schedule-assignments/${globalAssignment.body._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.isActive).toBe(false);
    expect(deactivated.body.supersededAt).toBeTruthy();

    await request(app)
      .patch(`/api/attendance/schedule-assignments/${setup.branchAssignmentId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    const resolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.source).toBeNull();
    expect(resolved.body.requiredWorkMinutes).toBe(0);
  });

  it('blocks staff from updating schedule assignments and blocks manager from global assignments', async () => {
    const seed = await seedUsers();
    const managerToken = await login('manager-a');
    const staffToken = await login('staff-one');
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const assignmentId = setup.branchAssignmentId;

    const managerGlobalAttempt = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        templateId: setup.templateId,
        targetType: 'global',
        effectiveFrom: '2099-05-01',
      });
    expect(managerGlobalAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .patch(`/api/attendance/schedule-assignments/${assignmentId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isActive: false });
    expect(managerAttempt.status).toBe(200);

    const staffAttempt = await request(app)
      .patch(`/api/attendance/schedule-assignments/${assignmentId}`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ isActive: false });
    expect(staffAttempt.status).toBe(403);
  });

  it('falls back to global schedule when branch template is inactive', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const dayShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Day Shift',
        startTime: '09:00',
        endTime: '17:00',
        requiredWorkMinutes: 420,
      });
    expect(dayShift.status).toBe(201);

    const lateShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Late Shift',
        startTime: '11:00',
        endTime: '19:00',
        requiredWorkMinutes: 420,
      });
    expect(lateShift.status).toBe(201);

    const globalTemplate = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Global Week',
        weeklyPattern: {
          monday: [dayShift.body._id],
          tuesday: [dayShift.body._id],
          wednesday: [dayShift.body._id],
          thursday: [dayShift.body._id],
          friday: [dayShift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: true,
      });
    expect(globalTemplate.status).toBe(201);

    const branchTemplate = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Inactive Branch Week',
        weeklyPattern: {
          monday: [lateShift.body._id],
          tuesday: [lateShift.body._id],
          wednesday: [lateShift.body._id],
          thursday: [lateShift.body._id],
          friday: [lateShift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: false,
      });
    expect(branchTemplate.status).toBe(201);

    const globalAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: globalTemplate.body._id,
        targetType: 'global',
        effectiveFrom: '2099-05-01',
      });
    expect(globalAssignment.status).toBe(201);

    const branchAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: branchTemplate.body._id,
        targetType: 'branch',
        branchId: seed.branchId,
        effectiveFrom: '2099-05-01',
      });
    expect(branchAssignment.status).toBe(201);

    const resolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      source: 'global',
      scheduledStart: '09:00',
      scheduledEnd: '17:00',
    });
  });

  it('rejects cross-branch schedule group members', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const staffTwo = await User.create({
      username: 'staff-two',
      password: 'password123',
      privilege: 'staff',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
    });
    const branchTwo = await Branch.create({
      name: 'Dubai Second',
      normalizedName: 'dubai-second',
      timezone: 'Asia/Dubai',
      staffs: [staffTwo._id],
      createdBy: seed.adminId,
      isActive: true,
      attendanceEnabled: true,
    });

    const earlyGroup = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Morning Team', branchId: seed.branchId, isActive: true });
    expect(earlyGroup.status).toBe(201);
    expect(earlyGroup.body.branchId).toBe(seed.branchId);

    const blockedMembers = await request(app)
      .put(`/api/attendance/schedule-groups/${earlyGroup.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.managerId, seed.staffId, String(staffTwo._id)] });
    expect(blockedMembers.status).toBe(400);

    const allowedMembers = await request(app)
      .put(`/api/attendance/schedule-groups/${earlyGroup.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.managerId, seed.staffId] });
    expect(allowedMembers.status).toBe(200);
    expect(allowedMembers.body.members).toHaveLength(2);

    const branchTwoGroup = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Second Branch Team', branchId: String(branchTwo._id), isActive: true });
    expect(branchTwoGroup.status).toBe(201);

    const branchTwoMembers = await request(app)
      .put(`/api/attendance/schedule-groups/${branchTwoGroup.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [String(staffTwo._id)] });
    expect(branchTwoMembers.status).toBe(200);

    const managerToken = await login('manager-a');
    const managerGroups = await request(app)
      .get('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(managerGroups.status).toBe(200);
    expect(managerGroups.body.items).toHaveLength(1);
    expect(managerGroups.body.items[0]._id).toBe(earlyGroup.body._id);
  });

  it('allows manager to manage branch templates, assignments, and group members', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const managerToken = await login('manager-a');

    const earlyShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Early Shift',
        startTime: '08:00',
        endTime: '16:00',
        requiredWorkMinutes: 420,
      });
    expect(earlyShift.status).toBe(201);

    const lateShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Late Shift',
        startTime: '12:00',
        endTime: '20:00',
        requiredWorkMinutes: 420,
      });
    expect(lateShift.status).toBe(201);

    const earlyGroup = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Early Team', branchId: seed.branchId, isActive: true });
    expect(earlyGroup.status).toBe(201);

    const lateGroup = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Late Team', branchId: seed.branchId, isActive: true });
    expect(lateGroup.status).toBe(201);

    const managerMembers = await request(app)
      .put(`/api/attendance/schedule-groups/${earlyGroup.body._id}/members`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ employeeIds: [seed.managerId, seed.staffId] });
    expect(managerMembers.status).toBe(200);

    const memberOptions = await request(app)
      .get(`/api/attendance/schedule-groups/${earlyGroup.body._id}/member-options`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(memberOptions.status).toBe(200);
    expect(memberOptions.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeId: seed.managerId,
          privilege: 'manager',
        }),
        expect.objectContaining({
          employeeId: seed.staffId,
          privilege: 'staff',
        }),
      ]),
    );

    const earlyTemplate = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        name: 'Early Week',
        weeklyPattern: {
          monday: [earlyShift.body._id],
          tuesday: [earlyShift.body._id],
          wednesday: [earlyShift.body._id],
          thursday: [earlyShift.body._id],
          friday: [earlyShift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: true,
      });
    expect(earlyTemplate.status).toBe(201);
    expect(earlyTemplate.body.branchId).toBe(seed.branchId);

    const lateTemplate = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        name: 'Late Week',
        weeklyPattern: {
          monday: [lateShift.body._id],
          tuesday: [lateShift.body._id],
          wednesday: [lateShift.body._id],
          thursday: [lateShift.body._id],
          friday: [lateShift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: true,
      });
    expect(lateTemplate.status).toBe(201);

    const globalTemplate = await request(app)
      .post('/api/attendance/schedule-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Global Week',
        weeklyPattern: {
          monday: [earlyShift.body._id],
          tuesday: [earlyShift.body._id],
          wednesday: [earlyShift.body._id],
          thursday: [earlyShift.body._id],
          friday: [earlyShift.body._id],
          saturday: [],
          sunday: [],
        },
        isActive: true,
      });
    expect(globalTemplate.status).toBe(201);

    const globalAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: globalTemplate.body._id,
        targetType: 'global',
        effectiveFrom: '2099-05-01',
      });
    expect(globalAssignment.status).toBe(201);

    const earlyAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        templateId: earlyTemplate.body._id,
        targetType: 'group',
        groupId: earlyGroup.body._id,
        effectiveFrom: '2099-05-01',
      });
    expect(earlyAssignment.status).toBe(201);

    const lateAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        templateId: lateTemplate.body._id,
        targetType: 'group',
        groupId: lateGroup.body._id,
        effectiveFrom: '2099-05-01',
      });
    expect(lateAssignment.status).toBe(201);

    const managerAssignments = await request(app)
      .get('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(managerAssignments.status).toBe(200);
    expect(managerAssignments.body.items).toHaveLength(3);
    expect(managerAssignments.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: globalAssignment.body._id,
          targetType: 'global',
        }),
      ]),
    );

    const resolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      source: 'group',
      scheduledStart: '08:00',
      scheduledEnd: '16:00',
    });

    const swapped = await request(app)
      .patch(`/api/attendance/schedule-assignments/${earlyAssignment.body._id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        templateId: lateTemplate.body._id,
        effectiveFrom: '2099-05-08',
      });
    expect(swapped.status).toBe(200);
  });

  it('returns pending group members in management responses when a group has an active assignment', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);

    const group = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Assigned Group', branchId: seed.branchId, isActive: true });
    expect(group.status).toBe(201);

    const assignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: setup.templateId,
        targetType: 'group',
        groupId: group.body._id,
        effectiveFrom: '2020-01-01',
      });
    expect(assignment.status).toBe(201);

    const updatedMembers = await request(app)
      .put(`/api/attendance/schedule-groups/${group.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.managerId] });
    expect(updatedMembers.status).toBe(200);
    expect(updatedMembers.body.members).toEqual([
      expect.objectContaining({
        employeeId: seed.managerId,
      }),
    ]);
    expect(new Date(updatedMembers.body.members[0].effectiveFrom).getTime()).toBeGreaterThan(Date.now());
    expect(updatedMembers.body.group.memberCount).toBe(1);

    const listedMembers = await request(app)
      .get(`/api/attendance/schedule-groups/${group.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listedMembers.status).toBe(200);
    expect(listedMembers.body.items).toEqual([
      expect.objectContaining({
        employeeId: seed.managerId,
      }),
    ]);
  });

  it('resolves employee, group, branch, and global schedule assignment priority', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');

    const earlyShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Early Shift',
        startTime: '08:00',
        endTime: '16:00',
        requiredWorkMinutes: 420,
      });
    expect(earlyShift.status).toBe(201);

    const lateShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Late Shift',
        startTime: '12:00',
        endTime: '20:00',
        requiredWorkMinutes: 420,
      });
    expect(lateShift.status).toBe(201);

    const exceptionShift = await request(app)
      .post('/api/attendance/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Exception Shift',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(exceptionShift.status).toBe(201);

    const template = async (name: string, shiftId: string) => {
      const response = await request(app)
        .post('/api/attendance/schedule-templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name,
          weeklyPattern: {
            monday: [shiftId],
            tuesday: [shiftId],
            wednesday: [shiftId],
            thursday: [shiftId],
            friday: [shiftId],
            saturday: [],
            sunday: [],
          },
          isActive: true,
        });
      expect(response.status).toBe(201);
      return response.body._id as string;
    };

    const branchTemplateId = await template('Branch Week', earlyShift.body._id);
    const groupTemplateId = await template('Group Week', lateShift.body._id);
    const employeeTemplateId = await template('Employee Week', exceptionShift.body._id);

    const group = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Late Group', branchId: seed.branchId, isActive: true });
    expect(group.status).toBe(201);

    const groupMembers = await request(app)
      .put(`/api/attendance/schedule-groups/${group.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.staffId] });
    expect(groupMembers.status).toBe(200);

    const branchAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: branchTemplateId,
        targetType: 'branch',
        branchId: seed.branchId,
        effectiveFrom: '2099-05-01',
      });
    expect(branchAssignment.status).toBe(201);

    const groupAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: groupTemplateId,
        targetType: 'group',
        groupId: group.body._id,
        effectiveFrom: '2099-05-01',
      });
    expect(groupAssignment.status).toBe(201);

    const resolvedGroup = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolvedGroup.status).toBe(200);
    expect(resolvedGroup.body).toMatchObject({
      source: 'group',
      scheduledStart: '12:00',
      scheduledEnd: '20:00',
    });

    const employeeAssignment = await request(app)
      .post('/api/attendance/schedule-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: employeeTemplateId,
        targetType: 'employee',
        employeeId: seed.staffId,
        effectiveFrom: '2099-05-01',
      });
    expect(employeeAssignment.status).toBe(201);

    const resolvedEmployee = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolvedEmployee.status).toBe(200);
    expect(resolvedEmployee.body).toMatchObject({
      source: 'employee',
      scheduledStart: '10:00',
      scheduledEnd: '18:00',
    });
  });

  it('increments shift version when an admin edits a shift', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);

    const updated = await request(app)
      .patch(`/api/attendance/shifts/${setup.shiftId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Full Day Updated',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      name: 'Full Day Updated',
      startTime: '10:00',
      endTime: '18:00',
      version: 2,
    });
    expect(updated.body.previousVersions).toHaveLength(1);
  });

  it('resolves day overrides by employee, group, branch, and global specificity', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);

    const group = await request(app)
      .post('/api/attendance/schedule-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Morning Crew', branchId: seed.branchId, isActive: true });
    expect(group.status).toBe(201);

    const members = await request(app)
      .put(`/api/attendance/schedule-groups/${group.body._id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.staffId] });
    expect(members.status).toBe(200);

    const globalHoliday = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2099-05-04', '2099-05-05', '2099-05-06', '2099-05-07'],
        overrideType: 'off_day',
        note: 'Holiday week',
      });
    expect(globalHoliday.status).toBe(201);
    expect(globalHoliday.body.items).toHaveLength(4);

    const globalResolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(globalResolved.status).toBe(200);
    expect(globalResolved.body).toMatchObject({
      requiredWorkMinutes: 0,
      overrideType: 'off_day',
    });
    expect(globalResolved.body.scheduledSegments).toEqual([]);

    const branchOverride = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'branch',
        branchId: seed.branchId,
        dates: ['2099-05-05', '2099-05-06', '2099-05-07'],
        overrideType: 'hours',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(branchOverride.status).toBe(201);

    const branchResolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-05' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(branchResolved.status).toBe(200);
    expect(branchResolved.body).toMatchObject({
      scheduledStart: '10:00',
      scheduledEnd: '18:00',
      requiredWorkMinutes: 420,
      overrideType: 'hours',
    });

    const groupOverride = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'group',
        groupId: group.body._id,
        dates: ['2099-05-06', '2099-05-07'],
        overrideType: 'hours',
        startTime: '12:00',
        endTime: '20:00',
        requiredWorkMinutes: 420,
      });
    expect(groupOverride.status).toBe(201);

    const groupResolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-06' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(groupResolved.status).toBe(200);
    expect(groupResolved.body).toMatchObject({
      scheduledStart: '12:00',
      scheduledEnd: '20:00',
      requiredWorkMinutes: 420,
      overrideType: 'hours',
    });

    const employeePreview = await request(app)
      .post('/api/attendance/day-overrides/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'employee',
        employeeId: seed.staffId,
        dates: ['2099-05-07'],
        overrideType: 'off_day',
      });
    expect(employeePreview.status).toBe(200);
    expect(employeePreview.body.conflicts).toHaveLength(0);

    const employeeOverride = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'employee',
        employeeId: seed.staffId,
        dates: ['2099-05-07'],
        overrideType: 'off_day',
        note: 'Approved admin exception',
      });
    expect(employeeOverride.status).toBe(201);

    const employeeResolved = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-07' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(employeeResolved.status).toBe(200);
    expect(employeeResolved.body).toMatchObject({
      requiredWorkMinutes: 0,
      overrideType: 'off_day',
    });
    expect(employeeResolved.body.scheduledSegments).toEqual([]);
  });

  it('previews and replaces same-target day override conflicts', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);

    const created = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2099-05-10', '2099-05-11'],
        overrideType: 'off_day',
      });
    expect(created.status).toBe(201);
    expect(created.body.items).toHaveLength(2);

    const preview = await request(app)
      .post('/api/attendance/day-overrides/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2099-05-10'],
        overrideType: 'hours',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(preview.status).toBe(200);
    expect(preview.body.conflicts).toEqual([
      expect.objectContaining({
        date: '2099-05-10',
        targetType: 'global',
        targetName: 'Global',
      }),
    ]);

    const rejected = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2099-05-10'],
        overrideType: 'hours',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(rejected.status).toBe(409);

    const replaced = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2099-05-10'],
        overrideType: 'hours',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
        confirmConflicts: true,
      });
    expect(replaced.status).toBe(201);
    expect(replaced.body.items[0]).toMatchObject({
      targetType: 'global',
      date: '2099-05-10',
      version: 2,
    });
  });

  it('lists only current day overrides by default and supports editing overrides', async () => {
    await seedUsers();
    const adminToken = await login('admin');

    const past = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2000-01-01'],
        overrideType: 'off_day',
      });
    expect(past.status).toBe(201);

    const future = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'global',
        dates: ['2099-05-12'],
        overrideType: 'hours',
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 420,
      });
    expect(future.status).toBe(201);

    const edited = await request(app)
      .patch(`/api/attendance/day-overrides/${future.body.items[0]._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        overrideType: 'hours',
        startTime: '11:00',
        endTime: '19:00',
        requiredWorkMinutes: 360,
        note: 'Edited hours',
      });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      date: '2099-05-12',
      startTime: '11:00',
      endTime: '19:00',
      requiredWorkMinutes: 360,
      note: 'Edited hours',
    });

    const defaultList = await request(app)
      .get('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(defaultList.status).toBe(200);
    expect(defaultList.body.items.map((item: any) => item.date)).toEqual(['2099-05-12']);

    const deactivated = await request(app)
      .patch(`/api/attendance/day-overrides/${future.body.items[0]._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.isActive).toBe(false);
    expect(deactivated.body.supersededAt).toBeTruthy();

    const activeList = await request(app)
      .get('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(activeList.status).toBe(200);
    expect(activeList.body.items).toHaveLength(0);

    const historyList = await request(app)
      .get('/api/attendance/day-overrides')
      .query({ includeHistory: true })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(historyList.status).toBe(200);
    expect(historyList.body.items.map((item: any) => item.date)).toEqual(
      expect.arrayContaining(['2000-01-01', '2099-05-12'])
    );
  });

  it('resolves branch assignment before global assignment for staff expected schedule', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);

    const response = await request(app)
      .get(`/api/attendance/employees/${seed.staffId}/schedule`)
      .query({ date: '2099-05-04' })
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
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });

    expect(checkIn.status).toBe(201);
    expect(checkIn.body).toMatchObject({
      type: 'check_in',
      branchLocalDate: '2099-05-04',
      branchLocalTime: '08:45',
      branchTimezone: 'Asia/Dubai',
    });

    const afterCheckInSnapshots = await request(app)
      .get('/api/attendance/me/daily-snapshots')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(afterCheckInSnapshots.status).toBe(200);
    expect(afterCheckInSnapshots.body.items[0]).toEqual(
      expect.objectContaining({
        status: 'incomplete',
        firstCheckIn: '08:45',
        employeeName: 'staff-one',
        overtimeMinutes: 0,
        undertimeMinutes: 0,
        generatedBy: 'event',
        calculationBasis: expect.objectContaining({
          scheduledStart: '09:00',
          scheduledEnd: '17:00',
          requiredWorkMinutes: 420,
        }),
      })
    );

    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2099-05-04T09:00:00.000Z',
      });

    expect(breakStart.status).toBe(201);
    expect(breakStart.body.type).toBe('break_start');

    const afterBreakStartSnapshots = await request(app)
      .get('/api/attendance/me/daily-snapshots')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(afterBreakStartSnapshots.status).toBe(200);
    expect(afterBreakStartSnapshots.body.items[0]).toMatchObject({
      status: 'open_break',
      overtimeMinutes: 0,
      undertimeMinutes: 0,
      generatedBy: 'event',
    });

    const breakEnd = await request(app)
      .post('/api/attendance/events/break-end')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T09:10:00.000Z',
      });

    expect(breakEnd.status).toBe(201);
    expect(breakEnd.body.type).toBe('break_end');

    const afterBreakEndSnapshots = await request(app)
      .get('/api/attendance/me/daily-snapshots')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(afterBreakEndSnapshots.status).toBe(200);
    expect(afterBreakEndSnapshots.body.items[0]).toMatchObject({
      status: 'incomplete',
      overtimeMinutes: 0,
      undertimeMinutes: 0,
      generatedBy: 'event',
    });

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T13:30:00.000Z',
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
        breakTypeName: 'Prayer',
        breakSubtypeName: 'Dhuhr',
        minutes: 10,
        allowedMinutes: expect.any(Number),
        unusedAllowedMinutes: expect.any(Number),
        overtimeMinutes: expect.any(Number),
        undertimeMinutes: 0,
      })
    );
  });

  it('requires staff face enrollment for check-in and break-end attendance events', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    await User.findByIdAndUpdate(seed.staffId, {
      $unset: {
        profileImageFile: '',
        faceEmbedding: '',
        faceEmbeddingModel: '',
        faceEmbeddingUpdatedAt: '',
        faceEmbeddingSourceImage: '',
      },
    });

    const missingCheckIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });

    expect(missingCheckIn.status).toBe(400);
    expect(missingCheckIn.body.message).toBe('Profile photo and face enrollment are required for attendance');

    const profileImage = await FileDocument.create({
      fileName: 'staff-one-updated.jpg',
      path: 'uploads/users/staff-one-updated.jpg',
      mimeType: 'image/jpeg',
      size: 123,
    });
    await User.findByIdAndUpdate(seed.staffId, {
      profileImageFile: profileImage._id,
      faceEmbedding: faceVector,
      faceEmbeddingModel: 'face_embedder.tflite',
      faceEmbeddingUpdatedAt: new Date(),
      faceEmbeddingSourceImage: profileImage._id,
    });

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(checkIn.status).toBe(201);

    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(breakStart.status).toBe(201);

    await User.findByIdAndUpdate(seed.staffId, {
      $unset: {
        faceEmbedding: '',
        faceEmbeddingModel: '',
        faceEmbeddingUpdatedAt: '',
        faceEmbeddingSourceImage: '',
      },
    });

    const missingBreakEnd = await request(app)
      .post('/api/attendance/events/break-end')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T09:10:00.000Z',
      });

    expect(missingBreakEnd.status).toBe(400);
    expect(missingBreakEnd.body.message).toBe('Profile photo and face enrollment are required for attendance');
  });

  it('requires valid branch GPS proof for non-admin attendance events', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    await Branch.findByIdAndUpdate(seed.branchId, { $unset: { location: '' } });
    const missingBranchLocation = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(missingBranchLocation.status).toBe(400);
    expect(missingBranchLocation.body.message).toBe('Branch location is required before attendance can be recorded');

    await Branch.findByIdAndUpdate(seed.branchId, {
      location: {
        latitude: branchLatitude,
        longitude: branchLongitude,
        updatedAt: new Date(),
        updatedBy: seed.adminId,
      },
    });

    const missingRequestLocation = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(missingRequestLocation.status).toBe(400);
    expect(missingRequestLocation.body.message).toBe('Current location is required for attendance');

    const weakAccuracy = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        location: {
          latitude: branchLatitude,
          longitude: branchLongitude,
          accuracyMeters: 150,
        },
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(weakAccuracy.status).toBe(400);
    expect(weakAccuracy.body.message).toContain('GPS accuracy is too weak');

    const tooFar = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        location: {
          latitude: branchLatitude + 0.01,
          longitude: branchLongitude,
          accuracyMeters: 20,
        },
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.message).toBe('You are too far from the branch location to record attendance');
  });

  it('manages remote workers for admins only and exposes addable member options', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const managerToken = await login('manager-a');
    const staffToken = await login('staff-one');

    const managerDenied = await request(app)
      .get('/api/attendance/remote-workers')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(managerDenied.status).toBe(403);

    const emptyList = await request(app)
      .get('/api/attendance/remote-workers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(emptyList.status).toBe(200);
    expect(emptyList.body.members).toEqual([]);

    const memberOptions = await request(app)
      .get('/api/attendance/remote-workers/member-options')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(memberOptions.status).toBe(200);
    expect(memberOptions.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeId: seed.managerId,
          privilege: 'manager',
          isActive: true,
        }),
        expect.objectContaining({
          employeeId: seed.staffId,
          privilege: 'staff',
          isActive: true,
        }),
      ]),
    );
    expect(
      memberOptions.body.items.some(
        (item: { employeeId: string }) => item.employeeId === seed.adminId,
      ),
    ).toBe(false);

    const updated = await request(app)
      .put('/api/attendance/remote-workers/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.staffId] });
    expect(updated.status).toBe(200);
    expect(updated.body.members).toEqual([
      expect.objectContaining({
        employeeId: seed.staffId,
        employeeName: 'staff-one',
        isActive: true,
      }),
    ]);

    const optionsAfterAdd = await request(app)
      .get('/api/attendance/remote-workers/member-options')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(optionsAfterAdd.status).toBe(200);
    expect(
      optionsAfterAdd.body.items.some(
        (item: { employeeId: string }) => item.employeeId === seed.staffId,
      ),
    ).toBe(false);
    expect(
      optionsAfterAdd.body.items.some(
        (item: { employeeId: string }) => item.employeeId === seed.managerId,
      ),
    ).toBe(true);

    const managerUpdateDenied = await request(app)
      .put('/api/attendance/remote-workers/members')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ employeeIds: [seed.managerId] });
    expect(managerUpdateDenied.status).toBe(403);
  });

  it('allows remote workers to check in without location but still requires face enrollment', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const addRemoteWorker = await request(app)
      .put('/api/attendance/remote-workers/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeIds: [seed.staffId] });
    expect(addRemoteWorker.status).toBe(200);

    const status = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(status.status).toBe(200);
    expect(status.body.isRemoteWorker).toBe(true);

    await User.findByIdAndUpdate(seed.staffId, {
      $unset: {
        faceEmbedding: '',
        faceEmbeddingModel: '',
        faceEmbeddingUpdatedAt: '',
        faceEmbeddingSourceImage: '',
      },
    });

    const missingFace = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ timestamp: '2099-05-04T04:45:00.000Z' });
    expect(missingFace.status).toBe(400);
    expect(missingFace.body.message).toBe('Profile photo and face enrollment are required for attendance');

    await User.findByIdAndUpdate(seed.staffId, {
      faceEmbedding: faceVector,
      faceEmbeddingModel: 'face_embedder.tflite',
      faceEmbeddingUpdatedAt: new Date(),
    });

    const checkInWithoutLocation = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ timestamp: '2099-05-04T04:45:00.000Z' });
    expect(checkInWithoutLocation.status).toBe(201);
  });

  it('allows admin attendance events without face enrollment', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await Branch.findByIdAndUpdate(seed.branchId, { manager: seed.adminId });
    await createAttendanceSetup(adminToken, seed);

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });

    expect(checkIn.status).toBe(201);

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T13:30:00.000Z',
      });

    expect(checkout.status).toBe(201);
  });

  it('allows staff to read my attendance status', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const response = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      date: '2099-05-04',
      workStatus: 'not_started',
      canCheckIn: true,
      canStartBreak: false,
      canEndBreak: false,
      canCheckOut: false,
      workedMinutes: 0,
      schedule: expect.objectContaining({
        source: 'branch',
        scheduledStart: '09:00',
        scheduledEnd: '17:00',
        requiredWorkMinutes: 420,
      }),
    });
  });

  it('returns only currently startable break options in my attendance status', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const openType = await request(app)
      .post('/api/attendance/break-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Open Lunch',
        isActive: true,
      });
    expect(openType.status).toBe(201);
    const openSubtype = await request(app)
      .post(`/api/attendance/break-types/${openType.body._id}/subtypes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Any time',
        isActive: true,
      });
    expect(openSubtype.status).toBe(201);
    const inactiveSubtype = await request(app)
      .post(`/api/attendance/break-types/${openType.body._id}/subtypes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Inactive',
        isActive: false,
      });
    expect(inactiveSubtype.status).toBe(201);

    const lateType = await request(app)
      .post('/api/attendance/break-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Late Window',
        isActive: true,
      });
    expect(lateType.status).toBe(201);
    const outsideWindowSubtype = await request(app)
      .post(`/api/attendance/break-types/${lateType.body._id}/subtypes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Almost never',
        windowStart: '23:59',
        windowEnd: '23:59',
        isActive: true,
      });
    expect(outsideWindowSubtype.status).toBe(201);

    const restrictedPrivilege = await request(app)
      .post('/api/attendance/privileges')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Restricted Break',
        isActive: true,
      });
    expect(restrictedPrivilege.status).toBe(201);
    const restrictedType = await request(app)
      .post('/api/attendance/break-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Restricted',
        privilegeIds: [restrictedPrivilege.body._id],
        isActive: true,
      });
    expect(restrictedType.status).toBe(201);
    const restrictedSubtype = await request(app)
      .post(`/api/attendance/break-types/${restrictedType.body._id}/subtypes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Private',
        inheritsParentPrivilege: true,
        isActive: true,
      });
    expect(restrictedSubtype.status).toBe(201);

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T04:45:00.000Z' });
    expect(checkIn.status).toBe(201);

    const status = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(status.status).toBe(200);
    expect(status.body.canStartBreak).toBe(true);

    const optionSubtypeIds = (status.body.breakOptions as Array<{ breakSubtypeId?: string }>)
      .map((option) => option.breakSubtypeId)
      .filter(Boolean);
    expect(status.body.breakOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          breakTypeId: openType.body._id,
          breakTypeName: 'Open Lunch',
          breakSubtypeId: openSubtype.body._id,
          breakSubtypeName: 'Any time',
        }),
      ])
    );
    expect(optionSubtypeIds).not.toContain(inactiveSubtype.body._id);
    expect(optionSubtypeIds).not.toContain(outsideWindowSubtype.body._id);
    expect(optionSubtypeIds).not.toContain(restrictedSubtype.body._id);

    const inactiveStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: openType.body._id,
        breakSubtypeId: inactiveSubtype.body._id,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(inactiveStart.status).toBe(400);
    expect(inactiveStart.body.message).toBe('Break subtype not found or inactive');

    const outsideWindowStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: lateType.body._id,
        breakSubtypeId: outsideWindowSubtype.body._id,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(outsideWindowStart.status).toBe(400);
    expect(outsideWindowStart.body.message).toBe('Break cannot be started outside its configured window');

    const restrictedStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: restrictedType.body._id,
        breakSubtypeId: restrictedSubtype.body._id,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(restrictedStart.status).toBe(403);
    expect(restrictedStart.body.message).toBe('Employee is not eligible for this break');

    const validStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: openType.body._id,
        breakSubtypeId: openSubtype.body._id,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(validStart.status).toBe(201);
    expect(validStart.body).toMatchObject({
      breakType: openType.body._id,
      breakSubtype: openSubtype.body._id,
    });
    expect(setup.breakTypeId).toBeTruthy();
  });

  it('blocks staff check-in when no schedule exists for today', async () => {
    await seedUsers();
    const staffToken = await login('staff-one');

    const status = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      workStatus: 'no_schedule',
      canCheckIn: false,
    });

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });

    expect(checkIn.status).toBe(400);
    expect(checkIn.body.message).toBe('No attendance schedule is available for today');
  });

  it('allows manager to resolve my attendance status from their managed branch', async () => {
    await seedUsers();
    const managerToken = await login('manager-a');

    const status = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${managerToken}`);

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      workStatus: 'no_schedule',
      canCheckIn: false,
      schedule: expect.objectContaining({
        source: null,
        requiredWorkMinutes: 0,
      }),
    });
  });

  it('blocks staff check-in on an off day override', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const override = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'employee',
        employeeId: seed.staffId,
        dates: ['2099-05-04'],
        overrideType: 'off_day',
        note: 'Holiday',
      });
    expect(override.status).toBe(201);

    const status = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      workStatus: 'no_schedule',
      canCheckIn: false,
      schedule: expect.objectContaining({
        overrideType: 'off_day',
        requiredWorkMinutes: 0,
      }),
    });

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(checkIn.status).toBe(400);
    expect(checkIn.body.message).toBe('No attendance schedule is available for today');
  });

  it('reports on-break status after reloading status and blocks checkout while the break is open', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T04:45:00.000Z',
      });
    expect(checkIn.status).toBe(201);

    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(breakStart.status).toBe(201);

    const status = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      workStatus: 'on_break',
      canCheckIn: false,
      canStartBreak: false,
      canEndBreak: true,
      canCheckOut: false,
      activeBreak: expect.objectContaining({
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        branchLocalTime: '13:00',
      }),
    });

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T13:30:00.000Z',
      });
    expect(checkout.status).toBe(409);
    expect(checkout.body.message).toBe('End the open break before checkout');
  });

  it('requires an open break to be closed before checkout correction', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T04:45:00.000Z' });
    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(breakStart.status).toBe(201);

    const snapshots = await request(app)
      .get('/api/attendance/team/daily-snapshots')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(snapshots.status).toBe(200);
    const snapshotId = snapshots.body.items[0]._id;
    expect(snapshots.body.items[0]).toMatchObject({ status: 'open_break' });

    const blockedCheckoutCorrection = await request(app)
      .post(`/api/attendance/daily-snapshots/${snapshotId}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '17:30',
        reason: 'Forgot checkout',
      });
    expect(blockedCheckoutCorrection.status).toBe(409);

    const staffBreakCorrection = await request(app)
      .post(`/api/attendance/daily-snapshots/${snapshotId}/corrections/break-end`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        breakEndTime: '13:15',
        reason: 'Trying to close my own break',
      });
    expect(staffBreakCorrection.status).toBe(403);

    const breakCorrection = await request(app)
      .post(`/api/attendance/daily-snapshots/${snapshotId}/corrections/break-end`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        breakEndTime: '13:15',
        reason: 'Admin verified break end.',
      });
    expect(breakCorrection.status).toBe(200);
    expect(breakCorrection.body.snapshot).toMatchObject({
      status: 'incomplete',
      generatedBy: 'correction',
    });
    expect(breakCorrection.body.snapshot).not.toHaveProperty('lastCheckOut');

    const checkoutCorrection = await request(app)
      .post(`/api/attendance/daily-snapshots/${snapshotId}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '17:30',
        reason: 'Admin verified checkout.',
      });
    expect(checkoutCorrection.status).toBe(200);
    expect(checkoutCorrection.body.snapshot).toMatchObject({
      status: 'present',
      lastCheckOut: '17:30',
    });
  });

  it('lists past unresolved snapshots in the team attention queue', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T05:00:00.000Z' });
    expect(checkIn.status).toBe(201);

    const attention = await request(app)
      .get('/api/attendance/team/daily-snapshots/attention')
      .query({ beforeDate: '2099-05-05' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(attention.status).toBe(200);
    expect(attention.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employee: seed.staffId,
          date: '2099-05-04',
          status: 'incomplete',
          firstCheckIn: '09:00',
        }),
      ])
    );

    const staffAttention = await request(app)
      .get('/api/attendance/team/daily-snapshots/attention')
      .query({ beforeDate: '2099-05-05' })
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffAttention.status).toBe(403);

    const snapshotId = attention.body.items[0]._id;
    const correction = await request(app)
      .post(`/api/attendance/daily-snapshots/${snapshotId}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '17:30',
        reason: 'Admin verified checkout.',
      });
    expect(correction.status).toBe(200);

    const afterCorrection = await request(app)
      .get('/api/attendance/team/daily-snapshots/attention')
      .query({ beforeDate: '2099-05-05' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterCorrection.status).toBe(200);
    expect(afterCorrection.body.items).toEqual([]);
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
        ...validAttendanceLocation,
        timestamp: '2099-05-04T05:00:00.000Z',
      });
    expect(checkIn.status).toBe(201);

    const breakStart = await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2099-05-04T09:00:00.000Z',
      });
    expect(breakStart.status).toBe(201);

    const breakEnd = await request(app)
      .post('/api/attendance/events/break-end')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T09:30:00.000Z',
      });
    expect(breakEnd.status).toBe(201);

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        timestamp: '2099-05-04T13:00:00.000Z',
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

  it('freezes schedule calculation basis across checkout correction unless recalculation is explicit', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const checkIn = await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T05:00:00.000Z' });
    expect(checkIn.status).toBe(201);

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T13:00:00.000Z' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.snapshot).toMatchObject({
      scheduledStart: '09:00',
      scheduledEnd: '17:00',
      requiredWorkMinutes: 420,
    });
    expect(checkout.body.snapshot.calculationBasis).toEqual(
      expect.objectContaining({
        source: 'branch',
        scheduledStart: '09:00',
        scheduledEnd: '17:00',
        requiredWorkMinutes: 420,
      })
    );
    expect(checkout.body.snapshot.calculationBasis.scheduledSegments[0]).toEqual(
      expect.objectContaining({
        shiftId: setup.shiftId,
        shiftVersion: 1,
        scheduledStart: '09:00',
        scheduledEnd: '17:00',
        requiredWorkMinutes: 420,
      })
    );

    const shiftEdit = await request(app)
      .patch(`/api/attendance/shifts/${setup.shiftId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        startTime: '10:00',
        endTime: '18:00',
        requiredWorkMinutes: 300,
      });
    expect(shiftEdit.status).toBe(200);

    const preserved = await request(app)
      .post(`/api/attendance/daily-snapshots/${checkout.body.snapshot._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '18:00',
        reason: 'Forgot updated checkout time',
      });
    expect(preserved.status).toBe(200);
    expect(preserved.body.snapshot).toMatchObject({
      scheduledStart: '09:00',
      scheduledEnd: '17:00',
      requiredWorkMinutes: 420,
      productiveWorkMinutes: 540,
      overtimeMinutes: 120,
    });
    expect(preserved.body.snapshot.calculationBasis.scheduledSegments[0]).toEqual(
      expect.objectContaining({
        shiftVersion: 1,
        requiredWorkMinutes: 420,
      })
    );

    const recalculated = await request(app)
      .post(`/api/attendance/daily-snapshots/${checkout.body.snapshot._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '19:00',
        reason: 'Admin approved recalculation with current schedule',
        recalculateBasis: true,
      });
    expect(recalculated.status).toBe(200);
    expect(recalculated.body.snapshot).toMatchObject({
      scheduledStart: '10:00',
      scheduledEnd: '18:00',
      requiredWorkMinutes: 300,
    });
    expect(recalculated.body.snapshot.calculationBasis.scheduledSegments[0]).toEqual(
      expect.objectContaining({
        shiftVersion: 2,
        requiredWorkMinutes: 300,
      })
    );
  });

  it('freezes day override and break rule basis for historical corrections', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const override = await request(app)
      .post('/api/attendance/day-overrides')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        targetType: 'employee',
        employeeId: seed.staffId,
        dates: ['2099-05-05'],
        overrideType: 'hours',
        startTime: '10:00',
        endTime: '16:00',
        requiredWorkMinutes: 300,
      });
    expect(override.status).toBe(201);

    await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-05T06:00:00.000Z' });
    await request(app)
      .post('/api/attendance/events/break-start')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ...validAttendanceLocation,
        breakTypeId: setup.breakTypeId,
        breakSubtypeId: setup.breakSubtypeId,
        timestamp: '2099-05-05T08:00:00.000Z',
      });
    await request(app)
      .post('/api/attendance/events/break-end')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-05T08:30:00.000Z' });

    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-05T11:00:00.000Z' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.snapshot).toMatchObject({
      scheduledStart: '10:00',
      scheduledEnd: '16:00',
      requiredWorkMinutes: 300,
      breakUndertimeMinutes: 15,
    });
    expect(checkout.body.snapshot.calculationBasis.dayOverride).toEqual(
      expect.objectContaining({
        overrideId: override.body.items[0]._id,
        targetType: 'employee',
        overrideType: 'hours',
        requiredWorkMinutes: 300,
      })
    );
    expect(checkout.body.snapshot.breakSessions[0]).toEqual(
      expect.objectContaining({
        breakTypeName: 'Prayer',
        breakSubtypeName: 'Dhuhr',
        maxMinutesPerDay: 75,
        maxMinutesPerEvent: 15,
        minutes: 30,
        excessMinutes: 15,
      })
    );

    const overrideEdit = await request(app)
      .patch(`/api/attendance/day-overrides/${override.body.items[0]._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        overrideType: 'hours',
        startTime: '12:00',
        endTime: '20:00',
        requiredWorkMinutes: 480,
      });
    expect(overrideEdit.status).toBe(200);

    const subtypeEdit = await request(app)
      .patch(`/api/attendance/break-subtypes/${setup.breakSubtypeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ maxMinutesPerEvent: 30 });
    expect(subtypeEdit.status).toBe(200);

    const preserved = await request(app)
      .post(`/api/attendance/daily-snapshots/${checkout.body.snapshot._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '16:30',
        reason: 'Correct checkout but preserve historical rules',
      });
    expect(preserved.status).toBe(200);
    expect(preserved.body.snapshot).toMatchObject({
      scheduledStart: '10:00',
      scheduledEnd: '16:00',
      requiredWorkMinutes: 300,
      breakUndertimeMinutes: 15,
    });
    expect(preserved.body.snapshot.breakSessions[0]).toEqual(
      expect.objectContaining({
        maxMinutesPerEvent: 15,
        excessMinutes: 15,
      })
    );

    const recalculated = await request(app)
      .post(`/api/attendance/daily-snapshots/${checkout.body.snapshot._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '17:00',
        reason: 'Explicitly recalculate after policy update',
        recalculateBasis: true,
      });
    expect(recalculated.status).toBe(200);
    expect(recalculated.body.snapshot).toMatchObject({
      scheduledStart: '12:00',
      scheduledEnd: '20:00',
      requiredWorkMinutes: 480,
      breakUndertimeMinutes: 0,
    });
    expect(recalculated.body.snapshot.breakSessions[0]).toEqual(
      expect.objectContaining({
        maxMinutesPerEvent: 30,
        excessMinutes: 0,
      })
    );
  });

  it('lazily captures a calculation basis for legacy snapshots that do not have one', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    const setup = await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    await request(app)
      .post('/api/attendance/events/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T05:00:00.000Z' });
    const checkout = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...validAttendanceLocation, timestamp: '2099-05-04T13:00:00.000Z' });
    expect(checkout.status).toBe(201);

    await AttendanceDailySnapshot.updateOne(
      { _id: checkout.body.snapshot._id },
      { $unset: { calculationBasis: '' } }
    );

    const shiftEdit = await request(app)
      .patch(`/api/attendance/shifts/${setup.shiftId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        startTime: '11:00',
        endTime: '19:00',
        requiredWorkMinutes: 240,
      });
    expect(shiftEdit.status).toBe(200);

    const corrected = await request(app)
      .post(`/api/attendance/daily-snapshots/${checkout.body.snapshot._id}/corrections/checkout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        checkoutTime: '18:00',
        reason: 'Legacy snapshot correction',
      });
    expect(corrected.status).toBe(200);
    expect(corrected.body.snapshot).toMatchObject({
      scheduledStart: '11:00',
      scheduledEnd: '19:00',
      requiredWorkMinutes: 240,
    });
    expect(corrected.body.snapshot.calculationBasis).toEqual(
      expect.objectContaining({
        scheduledStart: '11:00',
        scheduledEnd: '19:00',
        requiredWorkMinutes: 240,
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
        ...validAttendanceLocation,
        breakTypeId: new mongoose.Types.ObjectId().toString(),
      });

    expect(breakBeforeCheckIn.status).toBe(409);

    const checkoutBeforeCheckIn = await request(app)
      .post('/api/attendance/events/check-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send(validAttendanceLocation);

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
        ...validAttendanceLocation,
        timestamp: '2099-05-04T05:00:00.000Z',
      });

    expect(checkIn.status).toBe(201);

    const finalize = await request(app)
      .post('/api/attendance/jobs/finalize-daily-snapshots')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        branchId: seed.branchId,
        date: '2099-05-04',
      });

    expect(finalize.status).toBe(200);
    expect(finalize.body.createdSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employee: seed.staffId,
          status: 'missing_checkout',
          overtimeMinutes: 0,
          undertimeMinutes: 0,
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
      .query({ date: '2099-05-04' })
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
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(ownSummary.status).toBe(200);

    const otherEmployeeSummary = await request(app)
      .get(`/api/attendance/employees/${seed.managerId}/daily-snapshots`)
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(otherEmployeeSummary.status).toBe(403);
  });

  it('bypasses the attendance gate when branch attendanceEnabled is false', async () => {
    const seed = await seedUsers();
    await Branch.findByIdAndUpdate(seed.branchId, { attendanceEnabled: false });
    const staffToken = await login('staff-one');

    const response = await request(app)
      .get('/api/attendance/me/status')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workStatus: 'checked_out',
      canCheckIn: false,
      canStartBreak: false,
      canEndBreak: false,
      canCheckOut: false,
      workedMinutes: 0,
      attendanceGateBypassed: true,
      schedule: null,
      snapshot: null,
    });
  });

  it('enforces the attendance gate when branch attendanceEnabled is true', async () => {
    const seed = await seedUsers();
    const adminToken = await login('admin');
    await createAttendanceSetup(adminToken, seed);
    const staffToken = await login('staff-one');

    const response = await request(app)
      .get('/api/attendance/me/status')
      .query({ date: '2099-05-04' })
      .set('Authorization', `Bearer ${staffToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workStatus: 'not_started',
      canCheckIn: true,
    });
    expect(response.body.attendanceGateBypassed).toBeUndefined();
    expect(response.body.schedule).toEqual(expect.objectContaining({
      source: 'branch',
    }));
  });
});
