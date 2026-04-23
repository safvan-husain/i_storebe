import mongoose from 'mongoose';

const connectDb = async () => {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/i-store-db';
    try {
        const connection = await mongoose.connect(uri);
        console.log(`🟢 Mongo db connected:`, connection.connection.host);
    } catch (error) {
        console.log(error);
        process.exit(1);
    }
};

export default connectDb;
