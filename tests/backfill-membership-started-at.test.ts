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

import Activity from '../src/models/Activity';
import Branch from '../src/models/Branch';
import BranchMembership from '../src/models/BranchMembership';
import Lead from '../src/models/Lead';
import User from '../src/models/User';
import {
  backfillMembershipStartedAt,
  computeMembershipStartedAt,
} from '../src/scripts/backfillBranchSnapshots';

jest.setTimeout(60000);

describe('backfill membership startedAt', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'backfill-membership-started-at-test',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('uses earliest activity and user createdAt when they predate membership startedAt', async () => {
    const admin = await User.create({
      username: 'admin',
      password: 'password123',
      privilege: 'admin',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
    });
    const staff = await User.create({
      username: 'staff-historical',
      password: 'password123',
      privilege: 'staff',
      secondPrivilege: 'regular',
      isActive: true,
      isAccountDeleted: false,
      createdAt: new Date('2025-04-28T00:00:00.000Z'),
    });
    const branch = await Branch.create({
      name: 'Mattannur',
      normalizedName: 'mattannur',
      manager: admin._id,
      staffs: [staff._id],
      isActive: true,
      createdBy: admin._id,
      createdAt: new Date('2026-04-26T05:42:54.027Z'),
    });
    const membershipStartedAt = new Date('2026-04-26T05:42:54.027Z');
    await BranchMembership.create({
      branch: branch._id,
      user: staff._id,
      role: 'staff',
      startedAt: membershipStartedAt,
    });
    await Activity.create({
      activator: staff._id,
      actorBranch: branch._id,
      type: 'lead_added',
      action: 'historical lead',
      createdAt: new Date('2025-05-15T00:00:00.000Z'),
    });

    const nextStartedAt = await computeMembershipStartedAt({
      userId: staff._id,
      branchId: branch._id,
      currentStartedAt: membershipStartedAt,
      userCreatedAt: staff.createdAt,
    });

    expect(nextStartedAt.toISOString()).toBe(staff.createdAt.toISOString());

    const summary = await backfillMembershipStartedAt({ apply: true });
    expect(summary.membershipsStartedAtUpdated).toBe(1);

    const updated = await BranchMembership.findOne({ user: staff._id }).lean();
    expect(updated?.startedAt.toISOString()).toBe(staff.createdAt.toISOString());
  });
});
