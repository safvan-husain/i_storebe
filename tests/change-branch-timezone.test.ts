import mongoose, { Types } from 'mongoose';
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

import Branch from '../src/models/Branch';
import User from '../src/models/User';
import AttendanceEvent from '../src/models/AttendanceEvent';
import AttendanceDailySnapshot from '../src/models/AttendanceDailySnapshot';
import { changeBranchTimezone } from '../src/scripts/changeBranchTimezone';
import { branchLocalParts } from '../src/utils/branch_timezone';

jest.setTimeout(60000);

describe('changeBranchTimezone', () => {
  let mongo: MongoMemoryServer;
  let staffId: Types.ObjectId;
  let branchId: Types.ObjectId;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'change-branch-timezone-test',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();

    const admin = await User.create({
      username: 'admin',
      password: 'password123',
      privilege: 'admin',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
    });
    const staff = await User.create({
      username: 'staff-one',
      password: 'password123',
      privilege: 'staff',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
    });
    const branch = await Branch.create({
      name: 'Taliparamba',
      normalizedName: 'taliparamba',
      timezone: 'Asia/Dubai',
      createdBy: admin._id,
      isActive: true,
      staffs: [staff._id],
    });

    staffId = staff._id as Types.ObjectId;
    branchId = branch._id as Types.ObjectId;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('plans a timezone change on dry run without writing', async () => {
    const result = await changeBranchTimezone({
      dryRun: true,
      apply: false,
      branchName: 'Taliparamba',
      timezone: 'Asia/Kolkata',
      fixAttendance: false,
    });

    expect(result.mode).toBe('dry-run');
    expect(result.branchUpdated).toBe(true);
    expect(result.previousTimezone).toBe('Asia/Dubai');
    expect(result.nextTimezone).toBe('Asia/Kolkata');

    const branch = await Branch.findById(branchId).lean();
    expect(branch?.timezone).toBe('Asia/Dubai');
  });

  it('updates branch timezone and recomputes attendance event local fields when fix-attendance is enabled', async () => {
    const timestamp = new Date('2026-06-13T04:30:00.000Z');
    const dubaiLocal = branchLocalParts(timestamp, 'Asia/Dubai');
    const kolkataLocal = branchLocalParts(timestamp, 'Asia/Kolkata');

    await AttendanceEvent.create({
      employee: staffId,
      branch: branchId,
      type: 'check_in',
      timestamp,
      branchLocalDate: dubaiLocal.date,
      branchLocalTime: dubaiLocal.time,
      branchTimezone: 'Asia/Dubai',
      source: 'mobile',
      createdBy: staffId,
    });

    await AttendanceDailySnapshot.create({
      employee: staffId,
      branch: branchId,
      date: dubaiLocal.date,
      branchTimezone: 'Asia/Dubai',
      shiftIds: [],
      scheduledSegments: [],
      requiredWorkMinutes: 0,
      grossMinutes: 0,
      productiveWorkMinutes: 0,
      totalBreakMinutes: 0,
      breakOvertimeMinutes: 0,
      breakUndertimeMinutes: 0,
      overtimeMinutes: 0,
      undertimeMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      breakTotals: [],
      breakSessions: [],
      status: 'incomplete',
      generatedFromEventIds: [],
      generatedBy: 'event',
      generatedAt: new Date(),
      version: 1,
    });

    const result = await changeBranchTimezone({
      dryRun: false,
      apply: true,
      branchId: String(branchId),
      timezone: 'Asia/Kolkata',
      fixAttendance: true,
    });

    expect(result.eventUpdates).toHaveLength(1);
    expect(result.eventUpdates[0].nextBranchLocalDate).toBe(kolkataLocal.date);
    expect(result.eventUpdates[0].nextBranchLocalTime).toBe(kolkataLocal.time);

    const branch = await Branch.findById(branchId).lean();
    expect(branch?.timezone).toBe('Asia/Kolkata');

    const event = await AttendanceEvent.findOne({ employee: staffId }).lean();
    expect(event?.branchTimezone).toBe('Asia/Kolkata');
    expect(event?.branchLocalDate).toBe(kolkataLocal.date);
    expect(event?.branchLocalTime).toBe(kolkataLocal.time);

    const oldSnapshot = await AttendanceDailySnapshot.findOne({
      employee: staffId,
      date: dubaiLocal.date,
    }).lean();
    const newSnapshot = await AttendanceDailySnapshot.findOne({
      employee: staffId,
      date: kolkataLocal.date,
    }).lean();

    expect(oldSnapshot?.branchTimezone).toBe('Asia/Kolkata');
    expect(newSnapshot?.branchTimezone).toBe('Asia/Kolkata');
    expect(newSnapshot?.firstCheckIn).toBe(kolkataLocal.time);
  });

  it('rejects invalid timezone values', async () => {
    await expect(changeBranchTimezone({
      dryRun: true,
      apply: false,
      branchName: 'Taliparamba',
      timezone: 'Not/A_Timezone',
      fixAttendance: false,
    })).rejects.toThrow('Invalid timezone');
  });
});
