
import mongoose from 'mongoose';
import User, {IUser} from '../models/User';
import connectDb from '../config/db';
import {generateToken} from "../utils/jwtUtils";
require('dotenv').config();

const createAdminUser = async () => {
  try {
    await connectDb();
    // Check if admin already exists
    const adminExists = await User.findOne({ username: 'admin' });
    
    if (!adminExists) {
      // Create admin user
      const admin = await User.create({
        username: "admin",
        password: 'admin123', // Will be hashed automatically by the pre-save hook
        privilege: 'admin',
      });
      console.log('Admin created');
    }
    
    const superAdmin = await User.findOne({ username: "super_admin"})

    if(superAdmin) {
      await superAdmin.save();
    } else {
      let user = await User.create({
        username: "super_admin",
        password: 'admin123', // Will be hashed automatically by the pre-save hook
        privilege: 'admin',
        secondPrivilege: 'super'
      });
      user.token = generateToken(user);
      await user.save();
      console.log('Super Admin created')
    }
    
    process.exit();
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
};

createAdminUser().catch(err => console.log("error seeding admin", err));
