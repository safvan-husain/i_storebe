
import { Request, Response } from 'express';
import User, { UserPrivilege } from '../models/User';
import { generateToken } from '../utils/jwtUtils';
import asyncHandler from 'express-async-handler';

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400);
    throw new Error('Please provide email and password');
  }

  // Check if user exists
  const user = await User.findOne({ email });

  if (!user) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  // Check if password matches
  const isMatch = await user.comparePassword(password);

  if (!isMatch) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  res.json({
    _id: user._id,
    email: user.email,
    phone: user.phone,
    privileges: user.privileges,
    token: generateToken(user),
  });
});

// @desc    Create a new user
// @route   POST /api/users
// @access  Private (Admin and Manager can create users)
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const { email, phone, password, privileges } = req.body;
  
  if (!email || !phone || !password) {
    res.status(400);
    throw new Error('Please provide email, phone, and password');
  }

  // Check if user exists
  const userExists = await User.findOne({ email });

  if (userExists) {
    res.status(400);
    throw new Error('User already exists');
  }

  // Determine which privileges the requester can assign
  const requesterPrivileges = req.user.privileges as UserPrivilege[];
  
  let allowedPrivileges: UserPrivilege[] = ['staff'];
  
  if (requesterPrivileges.includes('admin')) {
    // Admin can create users with any privilege
    allowedPrivileges = ['admin', 'manager', 'staff'];
  } else if (requesterPrivileges.includes('manager')) {
    // Manager can only create staff
    allowedPrivileges = ['staff'];
  }
  
  // Filter requested privileges to only those allowed
  const validPrivileges = privileges ? 
    privileges.filter((p: string) => allowedPrivileges.includes(p as UserPrivilege)) : 
    ['staff'];

  const user = await User.create({
    email,
    phone,
    password,
    privileges: validPrivileges.length ? validPrivileges : ['staff'],
  });

  if (user) {
    res.status(201).json({
      _id: user._id,
      email: user.email,
      phone: user.phone,
      privileges: user.privileges,
      token: generateToken(user),
    });
  } else {
    res.status(400);
    throw new Error('Invalid user data');
  }
});

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Admin and Manager)
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const users = await User.find({}).select('-password');
  res.json(users);
});

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Private (Admin and Manager)
export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id).select('-password');
  
  if (user) {
    res.json(user);
  } else {
    res.status(404);
    throw new Error('User not found');
  }
});
