import {Request, Response} from 'express';

import asyncHandler from 'express-async-handler';
import {FilterQuery, Types} from 'mongoose';
import {employeeQuerySchema, getStaffRequestSchema} from "./validation";
import User, {IUser} from "../../models/User";
import Branch from "../../models/Branch";
import {onCatchError} from "../../middleware/error";
import {TypedResponse} from "../../common/interface";
import {ObjectIdSchema, UserPrivilegeSchema} from "../../common/types";
import {changeUserPasswordRequestSchema, inActivateUserRequestSchema} from "../leads/validations";
import {faceEmbeddingPayloadSchema} from "../auth/validation";
import {z} from "zod";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const faceEnrollmentUpdateSchema = z.object({
    faceEmbedding: faceEmbeddingPayloadSchema.refine(Boolean, { message: 'faceEmbedding is required' }),
});

const canManageFaceEnrollment = async (req: Request, userId: string, res: Response) => {
    if (!req.userId) {
        res.status(403).json({ message: 'user id not found' });
        return null;
    }
    if (req.privilege === UserPrivilegeSchema.enum.staff) {
        res.status(403).json({ message: 'Not authorized not access this api' });
        return null;
    }

    const user = await User.findById(userId)
        .select('_id username privilege profileImageFile isAccountDeleted faceEmbeddingModel faceEmbeddingUpdatedAt faceEmbeddingSourceImage +faceEmbedding')
        .populate('profileImageFile', '_id fileName path mimeType size')
        .lean();

    if (!user || user.isAccountDeleted) {
        res.status(404).json({ message: 'user not found' });
        return null;
    }

    if (req.privilege === UserPrivilegeSchema.enum.manager && user.privilege !== UserPrivilegeSchema.enum.staff) {
        res.status(403).json({ message: 'Managers can only manage staff users' });
        return null;
    }

    return user;
};

const faceEnrollmentResponse = (user: any) => ({
    userId: String(user._id),
    faceEnrolled: Array.isArray(user.faceEmbedding) && user.faceEmbedding.length > 0,
    faceEmbedding: user.faceEmbedding ?? null,
    faceEmbeddingModel: user.faceEmbeddingModel ?? null,
    faceEmbeddingUpdatedAt: user.faceEmbeddingUpdatedAt ?? null,
    profileImageFile: user.profileImageFile ?? null,
});

const getBranchMemberIds = async (branchId: string) => {
    const branch = await Branch.findById(branchId, { manager: true, staffs: true }).lean();
    if (!branch) return null;
    return [
        ...(branch.manager ? [branch.manager] : []),
        ...(branch.staffs ?? []),
    ].map(id => Types.ObjectId.createFromHexString(String(id)));
};

const getBranchMapForUsers = async (userIds: string[]) => {
    if (userIds.length === 0) return new Map<string, { _id: string, name: string }>();
    const objectIds = userIds.map(id => Types.ObjectId.createFromHexString(id));
    const branches = await Branch.find({
        $or: [
            { manager: { $in: objectIds } },
            { staffs: { $in: objectIds } },
        ],
    }, { name: true, manager: true, staffs: true }).lean();

    const branchMap = new Map<string, { _id: string, name: string }>();
    for (const branch of branches) {
        const value = { _id: String(branch._id), name: branch.name };
        if (branch.manager && userIds.includes(String(branch.manager))) {
            branchMap.set(String(branch.manager), value);
        }
        for (const staffId of branch.staffs ?? []) {
            if (userIds.includes(String(staffId))) {
                branchMap.set(String(staffId), value);
            }
        }
    }
    return branchMap;
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
        if (req.privilege !== UserPrivilegeSchema.enum.admin) {
            res.status(403).json({ message: 'Only admins can query employees' });
            return;
        }

        const filter = employeeQuerySchema.parse(req.body ?? {});
        const query: FilterQuery<IUser> = {
            isAccountDeleted: { $ne: true },
            privilege: { $in: filter.privileges },
        };

        if (typeof filter.active !== 'undefined') {
            query.isActive = filter.active;
        }
        if (filter.secondPrivileges && filter.secondPrivileges.length > 0) {
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
            faceEnrolled: Array.isArray((user as any).faceEmbedding) && (user as any).faceEmbedding.length > 0,
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
        const id = ObjectIdSchema.parse(req.params.id);
        const user = await canManageFaceEnrollment(req, id, res);
        if (!user) return;

        res.status(200).json(faceEnrollmentResponse(user));
    } catch (e) {
        onCatchError(e, res);
    }
});

export const updateFaceEnrollment = asyncHandler(async (req: Request, res: Response) => {
    try {
        const id = ObjectIdSchema.parse(req.params.id);
        const existingUser = await canManageFaceEnrollment(req, id, res);
        if (!existingUser) return;
        if (!(existingUser as any).profileImageFile) {
            res.status(400).json({ message: 'profile image is required before enrolling face' });
            return;
        }

        const parsedBody = faceEnrollmentUpdateSchema.safeParse(req.body);
        if (!parsedBody.success) {
            res.status(400).json({
                message: parsedBody.error.errors.length > 0
                    ? `${parsedBody.error.errors[0].path[0]}: ${parsedBody.error.errors[0].message}`
                    : 'Validation error',
                errors: parsedBody.error.errors,
            });
            return;
        }

        const { faceEmbedding } = parsedBody.data;
        if (!faceEmbedding) {
            res.status(400).json({ message: 'faceEmbedding is required' });
            return;
        }

        const user = await User.findByIdAndUpdate(
            id,
            {
                faceEmbedding: faceEmbedding.vector,
                faceEmbeddingModel: faceEmbedding.model,
                faceEmbeddingUpdatedAt: new Date(),
                faceEmbeddingSourceImage: (existingUser as any).profileImageFile._id ?? (existingUser as any).profileImageFile,
            },
            { new: true },
        )
            .select('_id username privilege profileImageFile faceEmbeddingModel faceEmbeddingUpdatedAt faceEmbeddingSourceImage +faceEmbedding')
            .populate('profileImageFile', '_id fileName path mimeType size')
            .lean();

        res.status(200).json(faceEnrollmentResponse(user));
    } catch (e) {
        onCatchError(e, res);
    }
});
