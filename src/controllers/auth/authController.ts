import {Request, Response} from 'express';
import User from '../../models/User';
import {generateToken} from '../../utils/jwtUtils';
import asyncHandler from 'express-async-handler';
import {loginSchema, UserRequestSchema} from './validation';
import {onCatchError} from '../../middleware/error';
import {Types} from 'mongoose';
import {ObjectIdSchema, SecondUserPrivilege, UserPrivilege, UserPrivilegeSchema} from "../../common/types";
import {TypedResponse} from "../../common/interface";
import {z} from "zod";

interface UserResponse {
    username: string;
    _id: string;
    privilege: UserPrivilege;
    secondPrivilege: SecondUserPrivilege;
}


export const loginUser = asyncHandler(async (req: Request, res: Response) => {
    try {
        const {username, password} = loginSchema.parse(req.body);

        const user = await User.findOne({username});
        if (!user) {
            res.status(401).json({message: 'user does not exist'});
            return;
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            res.status(401).json({message: 'incorrect password'});
            return;
        }
        let userObject: any = user.toObject();
        delete userObject.updatedAt;
        delete userObject.createdAt;
        delete userObject.password;
        delete userObject.__v;
        res.status(200).json({
            token: generateToken(user),
            ...userObject
        });
    } catch (error) {
        onCatchError(error, res);
    }
});

export const createUser = asyncHandler(async (req: Request, res: TypedResponse<UserResponse>) => {
    try {
        let {username, privilege, manager, ...rest} = UserRequestSchema.parse(req.body);

        // Validate requester permissions
        // const admin = await User.findById(req.userId);
        if (!['admin', 'manager'].includes(req?.privilege ?? "")) {
            res.status(403).json({message: "You don't have permission to create users"});
            return;
        }

        // Handle admin creating manager without specifying a [manager]branch
        if (req?.privilege === 'admin' && privilege === 'staff' && !manager) {
            res.status(400).json({message: "Admin should provide manager(branch) when creating staff"});
            return;
        }

        // Enforce manager permissions
        if (req?.privilege === 'manager') {
            if (privilege !== 'staff') {
                res.status(403).json({message: "You only have permission to create staff"});
                return;
            }
            manager = req.userId;
        }

        // Check if user already exists
        const userExists = await User.findOne({username});
        if (userExists) {
            res.status(400).json({message: "User already exists"});
            return;
        }

        // Set manager ID for staff creation
        const managerId = privilege === 'staff' ? manager : undefined;

        // Create user
        const user = (await User.create({
            ...rest,
            username,
            privilege,
            manager: managerId,
        }));

        let userObject: any = user.toObject();
        delete userObject.updatedAt;
        delete userObject.createdAt;
        delete userObject.password;
        delete userObject.__v;
        if (user) {
            res.status(201).json({
                username: userObject.username,
                _id: userObject._id,
                privilege: userObject.privilege,
                secondPrivilege: userObject.secondPrivilege,
            });
        } else {
            res.status(200).json({message: "Failed to create user"});
        }
    } catch (error) {
        onCatchError(error, res);
    }
});

export const getUsers = asyncHandler(async (req: Request, res: TypedResponse<UserResponse[]>) => {
    if(!req.userId) {
        res.status(401).json({message: "User not found"});
        return;
    }
    let filter = z.object({
        type: UserPrivilegeSchema.exclude(['admin']).optional()
    }).parse(req.query);
    let managerId;
    if(req.privilege === "staff") {
        let requester = await User.findById(req.userId, { manager: true }).lean();
        if(!requester) {
            res.status(401).json({message: "User not found"});
            return;
        }
        managerId = requester.manager;
    } else if (req.privilege === 'manager') {
        managerId = req.userId;
    }
    let query: any = {}
    if(managerId) {
        query.$or = [ { manager: managerId }, { _id: managerId }]
    }
    query.privilege = { $ne: 'admin' }
    if(filter.type) {
        query.privilege = filter.type;
    }
    const users = await User.find(query, {
        username: true,
        privilege: true,
        manager: true,
        secondPrivilege: true,
        createdAt: true
    }).lean();
    res.status(200).json(users.map(e => ({
            username: e.username,
            _id: e._id.toString(),
        privilege: e.privilege,
        secondPrivilege: e.secondPrivilege
    })));
});

export const getUserById = asyncHandler(async (req: Request, res: TypedResponse<UserResponse>) => {
    try {
        let id = ObjectIdSchema.parse(req.params.id);
        const user = await User.findById(id).select('-password');
        if (user) {
            res.status(200).json({
                username: user.username,
                _id: user._id.toString(),
                privilege: user.privilege,
                secondPrivilege: user.secondPrivilege
            });
            return;
        }
        res.status(404).json({message: 'User not found'});
    } catch (e) {
        onCatchError(e, res);
    }
});
