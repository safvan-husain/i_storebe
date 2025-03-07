import express from "express";
import mongoose from "mongoose";

const PORT = 3000;

const MONGO_URI = 'mongodb://localhost:27017/i-store-db';

const app = express();

mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Could not connect to MongoDB', err));
// Middleware to parse JSON requests
 app.use(express.json());

 // Basic route
 app.get('/', (req, res) => {
     res.send('Hello, World!');
     });
//
     // Start the server
     app.listen(PORT, () => {
         console.log(`Server is running on http://localhost:${PORT}`);
         });
