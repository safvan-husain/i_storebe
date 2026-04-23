import mongoose from 'mongoose';
import { logger } from '../logging/logger';

const connectDb = async () => {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/i-store-db';
    try {
        const connection = await mongoose.connect(uri);
        console.log(`🟢 Mongo db connected:`, connection.connection.host);
        await logger.log('MongoDB connected', {
            host: connection.connection.host,
        });
    } catch (error) {
        console.error(error);
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        await logger.error('MongoDB connection failed', {
            errorMessage: normalizedError.message,
            errorStack: normalizedError.stack,
        });
        process.exit(1);
    }
};

export default connectDb;
