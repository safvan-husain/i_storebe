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

import Branch from '../src/models/Branch';
import User from '../src/models/User';
import { backfillBranchAttendanceEnabled } from '../src/scripts/backfillBranchAttendanceEnabled';

jest.setTimeout(60000);

describe('backfillBranchAttendanceEnabled', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'backfill-branch-attendance-enabled-test',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('plans disabled branches and enables only 19th mile on dry run', async () => {
    const admin = await User.create({
      username: 'admin',
      password: 'password123',
      privilege: 'admin',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
    });

    await Branch.create([
      {
        name: '19th Mile',
        normalizedName: '19th mile',
        createdBy: admin._id,
        isActive: true,
      },
      {
        name: 'Taliparamba',
        normalizedName: 'taliparamba',
        createdBy: admin._id,
        isActive: true,
        attendanceEnabled: true,
      },
      {
        name: 'Mattannur',
        normalizedName: 'mattannur',
        createdBy: admin._id,
        isActive: true,
      },
    ]);

    const summary = await backfillBranchAttendanceEnabled({ dryRun: true, apply: false });

    expect(summary.mode).toBe('dry-run');
    expect(summary.enabled).toEqual([
      expect.objectContaining({ branchName: '19th Mile' }),
    ]);
    expect(summary.disabled).toEqual([
      expect.objectContaining({ branchName: 'Taliparamba' }),
    ]);
    expect(summary.unchanged).toEqual([
      expect.objectContaining({ branchName: 'Mattannur', attendanceEnabled: false }),
    ]);

    const branches = await Branch.find({}, { name: true, attendanceEnabled: true }).lean();
    expect(branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Taliparamba', attendanceEnabled: true }),
    ]));
  });

  it('applies attendanceEnabled values on apply', async () => {
    const admin = await User.create({
      username: 'admin',
      password: 'password123',
      privilege: 'admin',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
    });

    await Branch.create([
      {
        name: '19th Mile',
        normalizedName: '19th mile',
        createdBy: admin._id,
        isActive: true,
      },
      {
        name: 'Taliparamba',
        normalizedName: 'taliparamba',
        createdBy: admin._id,
        isActive: true,
        attendanceEnabled: true,
      },
    ]);

    const summary = await backfillBranchAttendanceEnabled({ dryRun: false, apply: true });

    expect(summary.mode).toBe('apply');
    expect(summary.enabled).toHaveLength(1);
    expect(summary.disabled).toHaveLength(1);

    const branches = await Branch.find({}, { name: true, attendanceEnabled: true })
      .sort({ name: 1 })
      .lean();

    expect(branches).toEqual([
      expect.objectContaining({ name: '19th Mile', attendanceEnabled: true }),
      expect.objectContaining({ name: 'Taliparamba', attendanceEnabled: false }),
    ]);
  });
});
