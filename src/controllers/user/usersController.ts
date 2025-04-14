import {Request, Response} from 'express';

import asyncHandler from 'express-async-handler';
import {getStaffRequestSchema} from "./validation";
import User from "../../models/User";
import {onCatchError} from "../../middleware/error";
import {TypedResponse} from "../../common/interface";
import {ObjectIdSchema, UserPrivilegeSchema} from "../../common/types";
import {changeUserPasswordRequestSchema, inActivateUserRequestSchema} from "../leads/validations";

export const getStaffs = asyncHandler(async (req: Request, res: Response) => {
    try {
        if (req.privilege === 'staff') {
            res.status(403).json({message: "Not allowed"})
            return;
        }
        const {manager} = getStaffRequestSchema.parse(req.params);
        let query: any = {};

        if (manager) query.manager = manager;
        if (req.privilege === 'manager') query.manager = req.userId;

        query.privilege = 'staff';

        let staffs = await User.find(query).lean();
        res.status(200).json(staffs);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const updateActiveStatus = async (req: Request, res: TypedResponse<any>) => {
    try {
        if(!req.userId) {
            res.status(403).json({message: "user id not found"});
            return;
        }
        if(req.privilege !== UserPrivilegeSchema.enum.admin) {
            res.status(403).json({ message: "Not authorized not access this api"})
            return;
        }
        const {id, isActive } = inActivateUserRequestSchema.parse(req.body);
        let user = await User.findByIdAndUpdate(id, {isActive});
        if(!user) {
            res.status(404).json({message: "user not found"});
            return;
        }
        res.status(200).json({message: isActive ? "user activated" : "user deactivated"});
    } catch (e) {
        onCatchError(e, res);
    }
}

export const changeUserPassword = async (req: Request, res: TypedResponse<any>) => {
    try {
        if(req.privilege !== UserPrivilegeSchema.enum.admin) {
            res.status(403).json({ message: "Not authorized not access this api"})
            return;
        }
        const {id, password } = changeUserPasswordRequestSchema.parse(req.body);
        //don't use findByIdAndUpdate, since it by bass pre save hook, hence no hashing for password.
        const user = await User.findById(id);
        if (!user) {
            res.status(404).json({ message: "User not found" });
            return;
        }
        user.password = password;
        user.isNewPassword = true;
        await user.save();
        res.status(200).json({message: "password changed"});
    } catch (e) {
        onCatchError(e, res);
    }
}

export const getManagers = asyncHandler(async (req: Request, res: Response) => {
    try {
        if (req.privilege === 'staff' || req.privilege === 'manager') {
            res.status(403).json({message: "Not allowed"});
            return;
        }
        let staffs = await User.find({privilege: 'manager'}).lean();
        res.status(200).json(staffs);
    } catch (e) {
        onCatchError(e, res);
    }
});