
import mongoose from 'mongoose';
import User from '../models/User';
import connectDb from '../config/db';
require('dotenv').config();

const createAdminUser = async () => {
  try {
    await connectDb();
    // Check if admin already exists
    const adminExists = await User.findOne({ phone: '1234567890' });
    
    if (!adminExists) {
      // Create admin user
      const admin = await User.create({
        name: "Admin",
        phone: '1234567890',
        password: 'admin123', // Will be hashed automatically by the pre-save hook
        privilege: 'admin',
      });
      console.log('Admin created');
    }
    
    const superAdmin = await User.findOne({ phone: "2234567890"})

    if(superAdmin) {
      superAdmin.isSuperAdmin = true;
      await superAdmin.save();
    } else {
      await User.create({
        name: "Super Admin",
        phone: '2234567890',
        password: 'admin123', // Will be hashed automatically by the pre-save hook
        privilege: 'admin',
        isSuperAdmin: true,
      });
      console.log('Super Admin created')
    }
    
    process.exit();
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
};

createAdminUser().catch(err => console.log("error seeding admin", err));
