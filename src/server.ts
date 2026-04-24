import express from "express";
import connectDb from "./config/db";
import cors from "cors";
import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import leadRoutes from "./routes/leadRoutes";
import taskRoutes from "./routes/taskRoutes";
import {activityRoutes} from "./routes/activityRoutes";
import {staticsRoutes} from "./routes/staticsRoutes";
import Lead from "./models/Lead";
import Activity from "./models/Activity";
import User from "./models/User";
import Task from "./models/Task";
import Leave from "./models/Leave";
import {generateToken} from "./utils/jwtUtils";
import {targetRoutes} from "./routes/targetRoutes";
import {leaveRouter} from "./routes/leave-routes";
import {errorHandler, onCatchError} from "./middleware/error";
import { notFound } from "./middleware/not_found";
import {customerRouter} from "./routes/customer-router";
import adminRoutes from "./routes/adminRoutes";
import customReportRoutes from "./routes/customReportRoutes";
import {branchRoutes} from "./routes/branchRoutes";
import {initializeApp} from "firebase-admin/app";
import {credential, ServiceAccount} from "firebase-admin";
import cron from 'node-cron';
import {wishBirthDayToCustomers} from "./services/wish-birth-day";
import {startTaskScheduler} from "./services/task-scheduler";
import { sendPushNotification } from "./services/notification-services";
import fs from 'fs';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { getOpenApiDocument } from './openapi/document';
import { logger } from './logging/logger';

require("dotenv").config();
const PORT = process.env.PORT || 3000;

const app = express();

function logProcessError(message: string, error: unknown) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  console.error(message, error);
  void logger.error(message, {
    errorMessage: normalizedError.message,
    errorStack: normalizedError.stack,
    details: error instanceof Error ? undefined : error,
  });
}

process.on('uncaughtException', (error) => {
  logProcessError('Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logProcessError('Unhandled promise rejection', reason);
});

function loadServiceAccount(): ServiceAccount {
  if (process.env.FIREBASE_SA_JSON) {
    return JSON.parse(process.env.FIREBASE_SA_JSON) as ServiceAccount;
  }

  if (process.env.FIREBASE_SA_B64) {
    const json = Buffer.from(process.env.FIREBASE_SA_B64, 'base64').toString('utf8');
    return JSON.parse(json) as ServiceAccount;
  } else {
    console.warn('FIREBASE_SA_B64 not set');
  }

  const saPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.resolve(__dirname, '../src/secret/serviceAccountKey.json');

  if (!fs.existsSync(saPath)) {
    throw new Error(
      `Firebase service account JSON not found. Set FIREBASE_SA_B64, or GOOGLE_APPLICATION_CREDENTIALS. Looked at: ${saPath}`
    );
  }

  const content = fs.readFileSync(saPath, 'utf8');
  return JSON.parse(content) as ServiceAccount;
}

connectDb().catch(err => {
  logProcessError('Startup database connection failed', err);
});

try {
  initializeApp({
    credential: credential.cert(loadServiceAccount()),
  });
} catch (error) {
  logProcessError('Firebase initialization failed', error);
  throw error;
}

app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

app.get('/', async (req, res) => {
    res.send('API is running');
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/analytics', staticsRoutes);
app.use('/api/target', targetRoutes);
app.use('/api/leave', leaveRouter);
app.use('/api/data', customerRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/custom-reports', customReportRoutes);
app.use('/api/branches', branchRoutes);

const openApiDocument = getOpenApiDocument();

app.get('/api/docs/openapi.json', (_req, res) => {
    res.json(openApiDocument);
});

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

const random10DigitNumber = (): number => {
    return Math.floor(1000000000 + Math.random() * 9000000000);
};

app.get('/api/transform', async (_, res) => {
    try {
        // Migration: reclassify status updates involving 'won' into new activity types
        // made_won: when status changed TO won
        // removed_won: when status changed FROM won
        const toWonQuery = {
            type: 'status_updated',
            action: { $regex: /status\s+to\s+won\b/i }
        } as any;
        const fromWonQuery = {
            type: 'status_updated',
            action: { $regex: /\bfrom\s+won\b/i }
        } as any;

        const [toWonResult, fromWonResult] = await Promise.all([
            Activity.updateMany(toWonQuery, { $set: { type: 'made_won' } }),
            Activity.updateMany(fromWonQuery, { $set: { type: 'removed_won' } })
        ]);

        res.status(200).json({
            ok: true,
            summary: {
                toWonMatched: (toWonResult as any).matchedCount ?? undefined,
                toWonModified: (toWonResult as any).modifiedCount ?? undefined,
                fromWonMatched: (fromWonResult as any).matchedCount ?? undefined,
                fromWonModified: (fromWonResult as any).modifiedCount ?? undefined,
            }
        });
    } catch (e) {
        const normalizedError = e instanceof Error ? e : new Error(String(e));
        console.error(e);
        void logger.error('Transform route failed', {
            status: 500,
            errorMessage: normalizedError.message,
            errorStack: normalizedError.stack,
            details: e instanceof Error ? undefined : e,
        });
        res.status(500).json(e)
    }
})

// Test push notification endpoint
// Body: { username: string, type: 'lead' | 'task' | 'leave', title?: string, body?: string }
app.post('/api/notifications/test', async (req, res) => {
    try {
        const { username, type, title, body } = req.body || {};
        if (!username || !type) {
            return res.status(400).json({ message: 'username and type are required' });
        }

        const normalizedType = String(type).toLowerCase();
        if (!['lead', 'task', 'leave'].includes(normalizedType)) {
            return res.status(400).json({ message: "type must be one of: 'lead', 'task', 'leave'" });
        }

        const user = await User.findOne({ username }, { _id: 1, username: 1, fcmToken: 1 }).lean();
        if (!user) {
            return res.status(404).json({ message: `User not found for username '${username}'` });
        }

        let entityId: string | undefined;
        if (normalizedType === 'lead') {
            const doc = await Lead.findOne({}, { _id: 1 }).sort({ createdAt: -1 }).lean();
            if (!doc) return res.status(404).json({ message: 'No lead found to test with' });
            entityId = String(doc._id);
            await sendPushNotification({
                title: title || 'Test Notification',
                body: body || 'Testing push with leadId payload',
                userId: String(user._id),
                leadId: entityId,
            });
        } else if (normalizedType === 'task') {
            const doc = await Task.findOne({}, { _id: 1 }).sort({ createdAt: -1 }).lean();
            if (!doc) return res.status(404).json({ message: 'No task found to test with' });
            entityId = String(doc._id);
            await sendPushNotification({
                title: title || 'Test Notification',
                body: body || 'Testing push with taskId payload',
                userId: String(user._id),
                taskId: entityId,
            });
        } else if (normalizedType === 'leave') {
            const doc = await Leave.findOne({}, { _id: 1 }).sort({ createdAt: -1 }).lean();
            if (!doc) return res.status(404).json({ message: 'No leave found to test with' });
            entityId = String(doc._id);
            await sendPushNotification({
                title: title || 'Test Notification',
                body: body || 'Testing push with leaveId payload',
                userId: String(user._id),
                leaveId: entityId,
            });
        }

        return res.status(200).json({
            ok: true,
            username,
            userId: String(user._id),
            hasFcmToken: Boolean((user as any).fcmToken),
            type: normalizedType,
            entityId,
        });
    } catch (e) {
        console.error('Error in /api/notifications/test', e);
        const normalizedError = e instanceof Error ? e : new Error(String(e));
        void logger.error('Notification test route failed', {
            status: 500,
            errorMessage: normalizedError.message,
            errorStack: normalizedError.stack,
        });
        return res.status(500).json({ message: 'Internal server error' });
    }
});

// Run daily at 12:00 AM IST
cron.schedule('0 0 * * *', async () => {
    console.log("Running cron job", new Date());
    try {
        await wishBirthDayToCustomers();
    } catch (error) {
        logProcessError('Birthday cron failed', error);
    }
}, {
    timezone: "Asia/Kolkata"
})

startTaskScheduler();

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
    void logger.log('Server started', {
        port: PORT,
    });
});
