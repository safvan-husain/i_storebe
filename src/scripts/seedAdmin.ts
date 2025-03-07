
import mongoose from 'mongoose';
import User from '../models/User';
import connectDb from '../config/db';
require('dotenv').config();

const createAdminUser = async () => {
  try {
    await connectDb();
    
    // Check if admin already exists
    const adminExists = await User.findOne({ email: 'admin@example.com' });
    
    if (adminExists) {
      console.log('Admin user already exists');
      process.exit();
    }
    
    // Create admin user
    const admin = await User.create({
      email: 'admin@example.com',
      phone: '1234567890',
      password: 'admin123', // Will be hashed automatically by the pre-save hook
      privileges: ['admin'],
    });
    
    console.log('Admin user created:', admin);
    process.exit();
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
};

createAdminUser();
