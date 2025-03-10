
import { Request, Response } from 'express';
import User from '../../models/User';
import { generateToken } from '../../utils/jwtUtils';
import asyncHandler from 'express-async-handler';
import { loginSchema, UserRequestSchema } from './validation';
import { onCatchError } from '../../middleware/error';
import { Types } from 'mongoose';

export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { phone, password } = loginSchema.parse(req.body);

    if (!phone || !password) {
      res.status(400).json({ message: 'Please provide phone and password' });
      return;
    }
    const user = await User.findOne({ phone });
    if (!user) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    res.status(200).json({
      _id: user._id,
      phone: user.phone,
      privilege: user.privilege,
      token: generateToken(user),
    });
  } catch (error) {
    onCatchError(error, res);
  }
});

export const createUser = asyncHandler(async (req: Request, res: Response) => {
  try {
    let { phone, privilege, manager, ...rest } = UserRequestSchema.parse(req.body);

    // Validate requester permissions
    const admin = await User.findById(req.userId);
    if (!['admin', 'manager'].includes(admin?.privilege ?? "")) {
      res.status(403).json({ message: "You don't have permission to create users" });
      return;
    }

    // Handle admin creating manager without specifying a [manager]branch
    if (admin?.privilege === 'admin' && privilege === 'staff' && !manager) {
      res.status(400).json({ message: "Admin should provide manager(branch) when creating staff" });
      return;
    }

    // Enforce manager permissions
    if (admin?.privilege === 'manager') {
      if (privilege !== 'staff') {
        res.status(403).json({ message: "You only have permission to create staff" });
        return;
      }
      manager = admin.id;
    }

    // Check if user already exists
    const userExists = await User.findOne({ phone });
    if (userExists) {
      res.status(400).json({ message: "User already exists" });
      return;
    }

    // Set manager ID for staff creation
    const managerId = privilege === 'staff' ? manager : undefined;

    // Create user
    const user = (await User.create({
      phone,
      privilege,
      manager: managerId,
      ...rest,
    }));

    let userObject: any = user.toObject();
    delete userObject.password;
    if (user) {
      res.status(201).json({
        token: generateToken(user),
        ...userObject
      });
    } else {
      res.status(200).json({ message: "Failed to create user" });
    }
  } catch (error) {
    onCatchError(error, res);
  }
});

export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const users = await User.find({}).select('-password');
  res.status(200).json(users);
});

export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  if(!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ message: 'Invalid user id' })    
    return;
  }
  const user = await User.findById(req.params.id).select('-password');
  if (user) {
    res.status(200).json(user);
  } else {
    res.status(404).json({ message: 'User not found'});
  }
});
