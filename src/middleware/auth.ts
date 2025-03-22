
import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwtUtils';
import {SecondUserPrivilege, UserPrivilege} from '../common/types';

// // Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      privilege: UserPrivilege;
      secondPrivilege: SecondUserPrivilege;
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
    req.secondPrivilege = decoded.secondPrivilege ?? "regular";
    next();
  } catch (error) {
    next(error);
  }
};