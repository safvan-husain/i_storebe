import {Request, Response} from 'express';

import asyncHandler from 'express-async-handler';
import {FilterQuery, Types} from 'mongoose';
import {employeeQuerySchema, getStaffRequestSchema} from "./validation";
import User, {IUser} from "../../models/User";
import Branch from "../../models/Branch";
import {onCatchError} from "../../middleware/error";
import {TypedResponse} from "../../common/interface";
import {UserPrivilegeSchema} from "../../common/types";
import {changeUserPasswordRequestSchema, inActivateUserRequestSchema} from "../leads/validations";
import {
    employeeFaceEnrollmentSummary,
    getFaceEnrollmentForRequest,
    getMyFaceEnrollmentForRequest,
    updateFaceEnrollmentForRequest,
} from "../../services/face-enrollment-service";
import { getBranchMapForUsers } from '../../services/user-branch-map';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getBranchMemberIds = async (branchId: string) => {
    const branch = await Branch.findById(branchId, { manager: true, staffs: true }).lean();
    if (!branch) return null;
    return [
        ...(branch.manager ? [branch.manager] : []),
        ...(branch.staffs ?? []),
    ].map(id => Types.ObjectId.createFromHexString(String(id)));
};

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
        query.isAccountDeleted = { $ne: true };

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
        if(req.privilege === UserPrivilegeSchema.enum.staff) {
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
        if(req.privilege === UserPrivilegeSchema.enum.staff) {
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
        let staffs = await User.find({
            privilege: 'manager',
            isAccountDeleted: { $ne: true },
        }).lean();
        res.status(200).json(staffs);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getActiveStaffsForManager = asyncHandler(async (req: Request, res: Response) => {
    try {
        if (req.privilege !== 'manager') {
            res.status(403).json({message: "Only managers can access active staff list"});
            return;
        }
        if (!req.userId) {
            res.status(400).json({message: "Manager id missing"});
            return;
        }

        const staffs = await User.find({
            privilege: 'staff',
            manager: req.userId,
            isActive: true,
            isAccountDeleted: { $ne: true },
        }).lean();

        res.status(200).json(staffs);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const queryEmployees = asyncHandler(async (req: Request, res: Response) => {
    try {
        const actorPrivilege = req.privilege;
        const isHr = req.secondPrivilege === 'hr';
        if (actorPrivilege === UserPrivilegeSchema.enum.staff && !isHr) {
            res.status(403).json({ message: 'Not authorized to query employees' });
            return;
        }
        if (actorPrivilege === UserPrivilegeSchema.enum.manager && !req.userId) {
            res.status(403).json({ message: 'Manager id missing' });
            return;
        }

        const filter = employeeQuerySchema.parse(req.body ?? {});
        const isManagerScoped = actorPrivilege === UserPrivilegeSchema.enum.manager && !isHr;
        const query: FilterQuery<IUser> = {
            isAccountDeleted: { $ne: true },
            privilege: isManagerScoped ? 'staff' : { $in: filter.privileges },
        };

        if (isManagerScoped) {
            query.manager = req.userId;
        }

        if (typeof filter.active !== 'undefined') {
            query.isActive = filter.active;
        }
        if (!isManagerScoped && filter.secondPrivileges && filter.secondPrivileges.length > 0) {
            query.secondPrivilege = { $in: filter.secondPrivileges };
        }
        if (filter.search) {
            query.username = { $regex: escapeRegex(filter.search), $options: 'i' };
        }

        if (filter.branchId || filter.excludeBranchId) {
            const branchId = filter.branchId ?? filter.excludeBranchId!;
            const memberIds = await getBranchMemberIds(branchId);
            if (!memberIds) {
                res.status(404).json({ message: 'Branch not found' });
                return;
            }
            query._id = filter.branchId
                ? { $in: memberIds }
                : { $nin: memberIds };
        }

        const total = await User.countDocuments(query);
        const usersQuery = User.find(query)
            .select('_id username privilege secondPrivilege isActive manager profileImageFile +faceEmbedding')
            .populate('profileImageFile', '_id fileName path mimeType size')
            .sort({ username: 1 })
            .skip(filter.skip)
            .lean();
        if (filter.limit) usersQuery.limit(filter.limit);

        const users = await usersQuery;
        const branchMap = await getBranchMapForUsers(users.map(user => String(user._id)));
        const employees = users.map(user => ({
            _id: String(user._id),
            username: user.username,
            privilege: user.privilege,
            secondPrivilege: user.secondPrivilege,
            isActive: user.isActive,
            profileImageFile: (user as any).profileImageFile ?? null,
            ...employeeFaceEnrollmentSummary(user as any),
            branch: branchMap.get(String(user._id)) ?? null,
        }));

        res.status(200).json({
            total,
            skip: filter.skip,
            limit: filter.limit ?? null,
            employees,
        });
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getFaceEnrollment = asyncHandler(async (req: Request, res: Response) => {
    try {
        res.status(200).json(await getFaceEnrollmentForRequest(req));
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getMyFaceEnrollment = asyncHandler(async (req: Request, res: Response) => {
    try {
        res.status(200).json(await getMyFaceEnrollmentForRequest(req));
    } catch (e) {
        onCatchError(e, res);
    }
});

export const updateFaceEnrollment = asyncHandler(async (req: Request, res: Response) => {
    try {
        res.status(200).json(await updateFaceEnrollmentForRequest(req));
    } catch (e) {
        onCatchError(e, res);
    }
});
