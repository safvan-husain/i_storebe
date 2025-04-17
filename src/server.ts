
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
import {generateToken} from "./utils/jwtUtils";
import {targetRoutes} from "./routes/targetRoutes";
import {leaveRouter} from "./routes/leave-routes";
import {onCatchError} from "./middleware/error";
import {customerRouter} from "./routes/customer-router";
import {initializeApp} from "firebase-admin/app";
import {credential} from "firebase-admin";
import serviceAccount from "./secret/serviceAccountKey.json";

require("dotenv").config();
const PORT = 3000;

const app = express();

connectDb().catch(err => console.log(err));
initializeApp({credential: credential.cert(serviceAccount as unknown as any)});
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

app.listen(PORT, () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
