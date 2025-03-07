
import express from "express";
import connectDb from "./config/db";
import cors from "cors";
import { errorHandler } from "./middleware/error";
import { notFound } from "./middleware/not_found";
import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import leadRoutes from "./routes/leadRoutes";
import User from "./models/User";
require("dotenv").config();

const PORT = 3000;

const app = express();

connectDb();
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json());

app.get('/', async (req, res) => {
    // console.log(
    // User.collection.listIndexes()
    // );
    console.log(await User.collection.listIndexes().toArray(

    ));


    // throw Error("Something went wrong");
    res.send('API is running');
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/leads', leadRoutes);

// Middleware for handling 404s and errors
// app.use(notFound);
// app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
