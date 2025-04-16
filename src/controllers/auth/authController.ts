import {Request, Response} from 'express';
import User, {IUser} from '../../models/User';
import {generateToken} from '../../utils/jwtUtils';
import asyncHandler from 'express-async-handler';
import {loginSchema, UserRequestSchema} from './validation';
import {onCatchError} from '../../middleware/error';
import {FilterQuery, Types} from 'mongoose';
import {ObjectIdSchema, SecondUserPrivilege, UserPrivilege, UserPrivilegeSchema} from "../../common/types";
import {TypedResponse} from "../../common/interface";
import {z} from "zod";
import {ManagerWithStaffs, managerWithStaffsSchema} from "../leads/validations";
import {runtimeValidation} from "../../utils/validation";

interface UserResponse {
    username: string;
    _id: string;
    privilege: UserPrivilege;
    secondPrivilege: SecondUserPrivilege;
    manager?: string;
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
        //when able to pass, set this, so allow access to other apis. using protect.
        user.isNewPassword = false;
        await user.save();

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

        //when creating user, manager field should be null for managers, otherwise getTarget api will not work as expected, and possibly some other.
        const managerId = privilege === 'staff' ? manager : undefined;
        if(managerId) {
                const managerExists = await User.findById(managerId, { privilege: true });
                if (!managerExists) {
                    res.status(404).json({message: "Manager not found"});
                    return;
                }
                if(managerExists.privilege !== 'manager') {
                    res.status(400).json({ message: "provided manager is not a manager"});
                    return;
                }
        }

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

export const getUsers = asyncHandler(async (req: Request, res: TypedResponse<ManagerWithStaffs[]>) => {
    try {
        if (!req.userId) {
            res.status(401).json({message: "requested user not found"});
            return;
        }
        let filter = z.object({
            type: UserPrivilegeSchema.exclude(['admin']).optional()
        }).parse(req.query);
        let managerId : Types.ObjectId | undefined;
        if (req.privilege === "staff") {
            let requester = await User.findById(req.userId, {manager: true}).lean();
            if (!requester) {
                res.status(401).json({message: "User not found"});
                return;
            }
            managerId = requester.manager;
        } else if (req.privilege === 'manager') {
            managerId = Types.ObjectId.createFromHexString(req.userId);
        }
        let query: FilterQuery<IUser> = {}
        if (managerId) {
            query.$or = [{manager: managerId}, {_id: managerId}]
        }
        query.privilege = {$ne: 'admin'}
        if (filter.type) {
            query.privilege = filter.type;
        }

        const users: ManagerWithStaffs[] = await User.aggregate([
            {
                $match: query
            },
            {
                $project: {
                    username: 1,
                    _id: 1,
                    privilege: 1,
                    secondPrivilege: 1,
                    manager: 1,
                    isActive: 1,
                }
            },
            {
                $group: {
                    _id: "$manager",
                    staffs: {
                        $push: "$$ROOT"
                    }
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "_id",
                    foreignField: "_id",
                    as: "manager"
                }
            },
            {
                $unwind: "$manager"
            },
            {
                $project: {
                    username: "$manager.username",
                    _id: "$_id",
                    privilege: "$manager.privilege",
                    secondPrivilege: "$manager.secondPrivilege",
                    isActive: "$manager.isActive",
                    staffs: 1
                }
            }
        ]);
        res.status(200).json(runtimeValidation(managerWithStaffsSchema, users as any));
    } catch (e) {
        onCatchError(e, res);
    }
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
