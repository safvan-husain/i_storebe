import express from "express";
import connectDb from "./config/db";
import cors from "cors";
require("dotenv").config();

const PORT = 3000;

const app = express();


connectDb();
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

app.listen(PORT, () => {
    console.log(`Server is running on http://13.127.230.46:${PORT}`);
});