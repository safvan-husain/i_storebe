
import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwtUtils';
import User from '../models/User';
import { UserPrivilege } from '../models/User';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: any;
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
      res.status(401);
      throw new Error('Not authorized, no token provided');
    }

    const decoded = verifyToken(token);
    
    if (!decoded) {
      res.status(401);
      throw new Error('Not authorized, token failed');
    }

    const user = await User.findById(decoded.id).select('-password');
    
    if (!user) {
      res.status(401);
      throw new Error('User not found');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

export const authorize = (privileges: UserPrivilege[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401);
      throw new Error('Not authorized, no user found');
    }

    const hasPrivilege = req.user.privileges.some((p: string) => 
      privileges.includes(p as UserPrivilege)
    );

    if (!hasPrivilege) {
      res.status(403);
      throw new Error('Not authorized, insufficient privileges');
    }

    next();
  };
};
