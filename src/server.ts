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
import User from "./models/User";
import Task from "./models/Task";
import Leave from "./models/Leave";
import {generateToken} from "./utils/jwtUtils";
import {targetRoutes} from "./routes/targetRoutes";
import {leaveRouter} from "./routes/leave-routes";
import {onCatchError} from "./middleware/error";
import {customerRouter} from "./routes/customer-router";
import adminRoutes from "./routes/adminRoutes";
import {initializeApp} from "firebase-admin/app";
import {credential, ServiceAccount} from "firebase-admin";
import cron from 'node-cron';
import {wishBirthDayToCustomers} from "./services/wish-birth-day";
import {startTaskScheduler} from "./services/task-scheduler";
import { sendPushNotification } from "./services/notification-services";
import fs from 'fs';
import path from 'path'

require("dotenv").config();
const PORT = process.env.PORT || 3000;

const app = express();

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

connectDb().catch(err => console.log(err));

initializeApp({
  credential: credential.cert(loadServiceAccount()),
});

app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json());

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

const random10DigitNumber = (): number => {
    return Math.floor(1000000000 + Math.random() * 9000000000);
};

app.get('/api/transform', async (_, res) => {
    try {
        let leads = await Lead.find({ handledBy: { $exists: false}});
        let s = await Promise.all(leads.map(async (e: any) => {
            e.createdBy = e.createdBy ?? e.toObject().manager;
            e.handledBy = e.handledBy ?? e.toObject().manager;
            return await e.save();
        }));
        // let users = await User.find({ token: { $exists: false }});
        // await Promise.all(users.map(async (e) => {
        //     e.token = generateToken(e);
        //     return await e.save();
        // }))
        // let users = await User.find({ username: { $exists: false }});
        // let s = await Promise.all(users.map(async (e) => {
        //    e.username = (e as any).phone;
        //     console.log(e.username, " ", (e as any).phone);
        //    return await e.save();
        // }));
        res.status(200).json({ s });
    } catch (e) {
        console.log(e);
        res.status(500).json(e)
    }
})

app.get('/api/token', async (req, res) => {
    try {
        let users = await User.find({ token: { $exists: false }});
        let s = await Promise.all(users.map(async (e) => {
            e.token = generateToken(e);
            return await e.save();
        }));

        let users2 = await User.find({}, { username: true, token: true, privilege: true, secondPrivilege: true }).lean();
        res.status(200).json({ s, users2 });
    } catch (e) {
       onCatchError(e, res);
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
        return res.status(500).json({ message: 'Internal server error' });
    }
});

// Run daily at 12:00 AM IST
cron.schedule('0 0 * * *', async () => {
    console.log("Running cron job", new Date());
    await wishBirthDayToCustomers();
}, {
    timezone: "Asia/Kolkata"
})

startTaskScheduler();

app.listen(PORT, () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
