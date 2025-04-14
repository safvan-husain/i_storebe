import {Request, Response, NextFunction} from 'express';
import {verifyToken} from '../utils/jwtUtils';
import {SecondUserPrivilege, UserPrivilege} from '../common/types';
import User from "../models/User";

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
            res.status(401).json({message: 'Not authorized, no token provided'});
            return;
        }

        const decoded = verifyToken(token);

        if (!decoded) {
            res.status(401).json({message: 'Not authorized, token failed'});
            return;
        }

        req.userId = decoded.id;
        req.privilege = decoded.privilege;
        req.secondPrivilege = decoded.secondPrivilege ?? "regular";

        const user = await User
            .findById(req.userId, {_id: true, isActive: true, isNewPassword: true})
            .lean<{ _id: true, isActive: true, isNewPassword: true }>();

        if (!user) {
            res.status(401).json({message: 'Not authorized, user not found'});
            return;
        } else if (!(user.isActive ?? true)) {
            res.status(401).json({message: 'Not authorized, user is inactive'});
            return;
        } else if ((user.isNewPassword ?? false)) {
            res.status(401).json({message: 'Not authorized, password has changed, please login again'});
            return;
        }
        next();
    } catch (error) {
        console.error('Protect middleware error:', error);
        res.status(500).json({message: 'Internal server error on auth'});
    }
};