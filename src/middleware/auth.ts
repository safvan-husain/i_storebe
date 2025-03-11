
import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwtUtils';
import { UserPrivilege } from '../enums/enums';

// // Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      privilege: UserPrivilege;
    }
  }
}

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      res.status(401).json({ message: 'Not authorized, no token provided'});
      return;
    }

    const decoded = verifyToken(token);
    
    if (!decoded) {
      res.status(401).json({ message: 'Not authorized, token failed'});
      return;
    }

    req.userId = decoded.id;
    req.privilege = decoded.privilege;
    next();
  } catch (error) {
    next(error);
  }
};

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import asyncHandler from 'express-async-handler';

// Add user to request type
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const protect = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret');

      // Get user from the token
      req.user = await User.findById((decoded as any).id).select('-password');

      next();
    } catch (error) {
      console.error(error);
      res.status(401);
      throw new Error('Not authorized, token failed');
    }
  }

  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }
});
