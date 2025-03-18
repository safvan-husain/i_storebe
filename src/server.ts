
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
import Customer from "./models/Customer";
import {ObjectId} from "mongoose";
import User from "./models/User";
import {generateToken} from "./utils/jwtUtils";
require("dotenv").config();

const PORT = 3000;

const app = express();

connectDb().catch(err => console.log(err));
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

const random10DigitNumber = (): number => {
    return Math.floor(1000000000 + Math.random() * 9000000000);
};

app.get('/api/transform', async (_, res) => {
    try {
        let leads = await Lead.find({ createdBy: { $exists: false}});
        await Promise.all(leads.map(async (e: any) => {
            e.createdBy = e.toObject().manager;
            return await e.save();
        }));
        let users = await User.find({ token: { $exists: false }});
        await Promise.all(users.map(async (e) => {
            e.token = generateToken(e);
            return await e.save();
        }))
        res.status(200).json({});
    } catch (e) {
        console.log(e);
        res.status(500).json(e)
    }
})

// Middleware for handling 404s and errors
// app.use(notFound);
// app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
