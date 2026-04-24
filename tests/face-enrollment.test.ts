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
import FileDocument from '../src/models/FileDocument';
import User from '../src/models/User';

jest.setTimeout(60000);

describe('Face enrollment', () => {
  let mongo: MongoMemoryServer;

  const vector = Array.from({ length: 128 }, (_, index) => index / 128);

  const seedUsers = async () => {
    const profileImage = await FileDocument.create({
      fileName: 'staff.jpg',
      path: 'uploads/users/staff.jpg',
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
        username: 'staff',
        password: 'password123',
        privilege: 'staff',
        secondPrivilege: 'regular',
        isActive: true,
        isAccountDeleted: false,
        profileImageFile: profileImage._id,
      },
      {
        username: 'staff-no-image',
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

  const getUserId = async (username: string) => {
    const user = await User.findOne({ username }).select('_id').lean();
    expect(user).toBeTruthy();
    return String(user!._id);
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'face-enrollment-test',
    });
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await seedUsers();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('allows admin to store and read face enrollment for a user with an image', async () => {
    const adminToken = await login('admin');
    const staffId = await getUserId('staff');

    const update = await request(app)
      .put(`/api/users/${staffId}/face-enrollment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        faceEmbedding: {
          model: 'face_embedder.tflite',
          vector,
        },
      });

    expect(update.status).toBe(200);
    expect(update.body.faceEnrolled).toBe(true);
    expect(update.body.faceEmbedding).toHaveLength(128);
    expect(update.body.faceEmbeddingModel).toBe('face_embedder.tflite');

    const read = await request(app)
      .get(`/api/users/${staffId}/face-enrollment`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(read.status).toBe(200);
    expect(read.body.faceEnrolled).toBe(true);
    expect(read.body.faceEmbedding).toEqual(vector);
  });

  it('blocks staff access to enrollment endpoints', async () => {
    const staffToken = await login('staff');
    const staffId = await getUserId('staff');

    const response = await request(app)
      .get(`/api/users/${staffId}/face-enrollment`)
      .set('Authorization', `Bearer ${staffToken}`);

    expect(response.status).toBe(403);
  });

  it('rejects invalid embeddings and users without profile images', async () => {
    const adminToken = await login('admin');
    const staffId = await getUserId('staff');
    const noImageId = await getUserId('staff-no-image');

    const invalid = await request(app)
      .put(`/api/users/${staffId}/face-enrollment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        faceEmbedding: {
          model: 'face_embedder.tflite',
          vector: [1, 2, 3],
        },
      });

    expect(invalid.status).toBe(400);

    const missingImage = await request(app)
      .put(`/api/users/${noImageId}/face-enrollment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        faceEmbedding: {
          model: 'face_embedder.tflite',
          vector,
        },
      });

    expect(missingImage.status).toBe(400);
    expect(missingImage.body.message).toContain('profile image');
  });

  it('returns faceEnrolled in employee query without leaking vectors', async () => {
    const adminToken = await login('admin');
    const staffId = await getUserId('staff');

    await request(app)
      .put(`/api/users/${staffId}/face-enrollment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        faceEmbedding: {
          model: 'face_embedder.tflite',
          vector,
        },
      });

    const response = await request(app)
      .post('/api/users/employees/query')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        privileges: ['staff'],
        limit: 10,
      });

    expect(response.status).toBe(200);
    const enrolled = response.body.employees.find((user: { _id: string }) => user._id === staffId);
    expect(enrolled.faceEnrolled).toBe(true);
    expect(enrolled.faceEmbedding).toBeUndefined();
  });
});
