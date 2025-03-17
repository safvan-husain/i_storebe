import {Request, Response} from 'express';

import asyncHandler from 'express-async-handler';
import {getStaffRequestSchema} from "./validation";
import User from "../../models/User";
import {onCatchError} from "../../middleware/error";

export const getStaffs = asyncHandler(async (req: Request, res: Response) => {
    try {
        if(req.privilege === 'staff') {
            res.status(403).json({ message: "Not allowed"})
            return;
        }
        const { manager } = getStaffRequestSchema.parse(req.params);
        let query: any = {};

        if(manager) query.manager = manager;
        if(req.privilege === 'manager') query.manager = req.userId;

        query.privilege = 'staff';

        let staffs = await User.find(query).lean();
        res.status(200).json(staffs);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getManagers = asyncHandler(async (req: Request, res: Response) => {
    try {
        if(req.privilege === 'staff' || req.privilege === 'manager') {
            res.status(403).json({ message: "Not allowed"});
            return;
        }
        let staffs = await User.find({ privilege: 'manager' }).lean();
        res.status(200).json(staffs);
    } catch (e) {
        onCatchError(e, res);
    }
});