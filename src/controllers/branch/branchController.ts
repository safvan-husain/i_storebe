import { Request, Response } from 'express';
import asyncHandler from 'express-async-handler';
import { FilterQuery, Types } from 'mongoose';
import Branch, { IBranch } from '../../models/Branch';
import User from '../../models/User';
import Activity from '../../models/Activity';
import { AppError, onCatchError } from '../../middleware/error';
import { ObjectIdSchema, UserPrivilegeSchema } from '../../common/types';
import { addStaffSchema, createBranchSchema, updateBranchSchema } from './validation';

const normalizeBranchName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

type BranchActivityType =
    | 'branch_created'
    | 'branch_updated'
    | 'branch_staff_added'
    | 'branch_staff_removed'
    | 'branch_staff_transferred'
    | 'branch_location_updated'
    | 'branch_activated'
    | 'branch_inactivated';

const ensureAdmin = (req: Request) => {
    if (req.privilege !== UserPrivilegeSchema.enum.admin) {
        throw new AppError('Only admins can manage branches', 403);
    }
};

const toObjectId = (id: string) => Types.ObjectId.createFromHexString(id);

const uniqueObjectIds = (ids: (string | Types.ObjectId)[]) => {
    const seen = new Set<string>();
    return ids.reduce<Types.ObjectId[]>((acc, id) => {
        const value = String(id);
        if (!seen.has(value)) {
            seen.add(value);
            acc.push(typeof id === 'string' ? toObjectId(id) : id);
        }
        return acc;
    }, []);
};

const assertUserRole = async (id: string | Types.ObjectId, privilege: 'manager' | 'staff') => {
    const user = await User.findById(id, { username: true, privilege: true, isAccountDeleted: true }).lean();
    if (!user || user.isAccountDeleted) {
        throw new AppError(`${privilege === 'manager' ? 'Manager' : 'Staff'} not found`, 404);
    }
    if (user.privilege !== privilege) {
        throw new AppError(`Selected user is not a ${privilege}`, 400);
    }
    return user;
};

const findMembershipConflicts = async ({
    branchId,
    managerId,
    staffIds,
}: {
    branchId?: Types.ObjectId,
    managerId?: Types.ObjectId,
    staffIds?: Types.ObjectId[],
}) => {
    const or: FilterQuery<IBranch>[] = [];
    if (managerId) or.push({ manager: managerId });
    if (staffIds && staffIds.length > 0) or.push({ staffs: { $in: staffIds } });
    if (or.length === 0) return [];

    const query: FilterQuery<IBranch> = { $or: or };
    if (branchId) query._id = { $ne: branchId };

    const branches = await Branch.find(query)
        .select('_id name manager staffs')
        .populate('manager', 'username')
        .populate('staffs', 'username')
        .lean();

    const conflicts: any[] = [];
    for (const branch of branches) {
        if (managerId && String(branch.manager?._id ?? branch.manager) === String(managerId)) {
            conflicts.push({
                type: 'manager',
                userId: String(managerId),
                username: (branch.manager as any)?.username,
                branchId: String(branch._id),
                branchName: branch.name,
            });
        }

        for (const staff of (branch.staffs ?? []) as any[]) {
            const staffId = String(staff._id ?? staff);
            if (staffIds?.some(id => String(id) === staffId)) {
                conflicts.push({
                    type: 'staff',
                    userId: staffId,
                    username: staff.username,
                    branchId: String(branch._id),
                    branchName: branch.name,
                });
            }
        }
    }

    return conflicts;
};

const throwConflicts = (conflicts: any[], targetBranch: { _id: Types.ObjectId, name: string }) => {
    if (conflicts.length === 0) return;
    throw new AppError('Selected users already belong to another branch', 409, {
        conflicts: conflicts.map(conflict => ({
            ...conflict,
            targetBranchId: String(targetBranch._id),
            targetBranchName: targetBranch.name,
        })),
    });
};

const removeUsersFromOtherBranches = async ({
    branchId,
    managerId,
    staffIds,
}: {
    branchId: Types.ObjectId,
    managerId?: Types.ObjectId,
    staffIds?: Types.ObjectId[],
}) => {
    if (managerId) {
        await Branch.updateMany(
            { _id: { $ne: branchId }, manager: managerId },
            { $unset: { manager: '' }, $set: { isActive: false } }
        );
    }
    if (staffIds && staffIds.length > 0) {
        await Branch.updateMany(
            { _id: { $ne: branchId }, staffs: { $in: staffIds } },
            { $pull: { staffs: { $in: staffIds } } }
        );
    }
};

const syncStaffManagers = async (staffIds: Types.ObjectId[], managerId?: Types.ObjectId | null) => {
    if (staffIds.length === 0) return;
    await User.updateMany(
        { _id: { $in: staffIds }, privilege: 'staff' },
        { $set: { manager: managerId ?? null } }
    );
};

const getUsernames = async (ids: Types.ObjectId[]) => {
    if (ids.length === 0) return [];
    const users = await User.find({ _id: { $in: ids } }, { username: true }).lean();
    return users.map(user => user.username);
};

const logBranchActivity = async ({
    req,
    type,
    branchName,
    message,
}: {
    req: Request,
    type: BranchActivityType,
    branchName: string,
    message: string,
}) => {
    if (!req.userId) return;
    await Activity.createActivity({
        activator: toObjectId(req.userId),
        type,
        action: `${req.username ?? 'Admin'} ${message}`,
        optionalMessage: `Branch: ${branchName}`,
    });
};

const serializeBranch = async (branchId: Types.ObjectId | string) => {
    return Branch.findById(branchId)
        .populate('manager', 'username privilege secondPrivilege isActive')
        .populate('staffs', 'username privilege secondPrivilege isActive')
        .lean();
};

export const createBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        ensureAdmin(req);
        if (!req.userId) throw new AppError('User id not found', 401);

        const data = createBranchSchema.parse(req.body);
        if (data.isActive && !data.managerId) {
            throw new AppError('Active branch requires a manager', 400);
        }
        if (data.staffIds.length > 0 && !data.managerId) {
            throw new AppError('Branch requires a manager before assigning staff', 400);
        }

        const normalizedName = normalizeBranchName(data.name);
        const existing = await Branch.findOne({ normalizedName }, { _id: true }).lean();
        if (existing) throw new AppError('Branch name already exists', 400);

        const managerId = data.managerId ? toObjectId(data.managerId) : undefined;
        const staffIds = uniqueObjectIds(data.staffIds);
        if (managerId) await assertUserRole(managerId, 'manager');
        for (const staffId of staffIds) await assertUserRole(staffId, 'staff');

        const tempTarget = { _id: new Types.ObjectId(), name: data.name.trim() };
        const conflicts = await findMembershipConflicts({ managerId, staffIds });
        if (!data.confirmMove) throwConflicts(conflicts, tempTarget);

        const branch = await Branch.create({
            name: data.name.trim().replace(/\s+/g, ' '),
            normalizedName,
            manager: managerId,
            staffs: staffIds,
            location: data.location ? {
                latitude: data.location.latitude,
                longitude: data.location.longitude,
                updatedAt: new Date(),
                updatedBy: toObjectId(req.userId),
            } : undefined,
            isActive: data.isActive,
            createdBy: toObjectId(req.userId),
        });

        await removeUsersFromOtherBranches({ branchId: branch._id, managerId, staffIds });
        if (staffIds.length > 0) await syncStaffManagers(staffIds, managerId);
        const manager = managerId ? await User.findById(managerId, { username: true }).lean() : null;
        await logBranchActivity({
            req,
            type: 'branch_created',
            branchName: branch.name,
            message: `created branch "${branch.name}"${manager ? ` with manager ${manager.username}` : ''}`,
        });
        if (staffIds.length > 0) {
            await logBranchActivity({
                req,
                type: conflicts.length > 0 ? 'branch_staff_transferred' : 'branch_staff_added',
                branchName: branch.name,
                message: `${conflicts.length > 0 ? 'transferred' : 'added'} staff ${((await getUsernames(staffIds)).join(', '))} to branch "${branch.name}"`,
            });
        }
        if (data.location) {
            await logBranchActivity({
                req,
                type: 'branch_location_updated',
                branchName: branch.name,
                message: `set location for branch "${branch.name}" to ${data.location.latitude}, ${data.location.longitude}`,
            });
        }

        res.status(201).json(await serializeBranch(branch._id));
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getBranches = asyncHandler(async (req: Request, res: Response) => {
    try {
        ensureAdmin(req);
        const branches = await Branch.find()
            .sort({ isActive: -1, name: 1 })
            .populate('manager', 'username privilege secondPrivilege isActive')
            .populate('staffs', 'username privilege secondPrivilege isActive')
            .lean();
        res.status(200).json(branches);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getBranchById = asyncHandler(async (req: Request, res: Response) => {
    try {
        ensureAdmin(req);
        const branchId = ObjectIdSchema.parse(req.params.id);
        const branch = await serializeBranch(branchId);
        if (!branch) throw new AppError('Branch not found', 404);
        res.status(200).json(branch);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const updateBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        ensureAdmin(req);
        const branchId = toObjectId(ObjectIdSchema.parse(req.params.id));
        const data = updateBranchSchema.parse(req.body);

        const branch = await Branch.findById(branchId);
        if (!branch) throw new AppError('Branch not found', 404);
        const oldName = branch.name;
        const oldManager = branch.manager ? String(branch.manager) : undefined;
        const oldIsActive = branch.isActive;
        const oldLocation = branch.location
            ? { latitude: branch.location.latitude, longitude: branch.location.longitude }
            : undefined;

        const nextIsActive = data.isActive ?? branch.isActive;
        const nextManager = typeof data.managerId !== 'undefined'
            ? (data.managerId ? toObjectId(data.managerId) : undefined)
            : branch.manager;
        const nextStaffs = data.staffIds ? uniqueObjectIds(data.staffIds) : branch.staffs;

        if (nextIsActive && !nextManager) {
            throw new AppError('Active branch requires a manager', 400);
        }
        if (nextStaffs.length > 0 && !nextManager) {
            throw new AppError('Branch requires a manager before assigning staff', 400);
        }

        if (data.name) {
            const normalizedName = normalizeBranchName(data.name);
            const existing = await Branch.findOne({ normalizedName, _id: { $ne: branchId } }, { _id: true }).lean();
            if (existing) throw new AppError('Branch name already exists', 400);
            branch.name = data.name.trim().replace(/\s+/g, ' ');
            branch.normalizedName = normalizedName;
        }
        if (data.location === null && branch.location) {
            throw new AppError('Branch location cannot be cleared after it is set', 400);
        }
        if (data.location) {
            branch.location = {
                latitude: data.location.latitude,
                longitude: data.location.longitude,
                updatedAt: new Date(),
                updatedBy: toObjectId(req.userId!),
            };
        }

        if (nextManager) await assertUserRole(nextManager, 'manager');
        for (const staffId of nextStaffs) await assertUserRole(staffId, 'staff');

        const conflicts = await findMembershipConflicts({
            branchId,
            managerId: nextManager,
            staffIds: nextStaffs,
        });
        if (!data.confirmMove) throwConflicts(conflicts, branch);

        const previousStaffs = branch.staffs.map(id => String(id));
        const nextStaffStrings = nextStaffs.map(id => String(id));
        const removedStaffs = previousStaffs
            .filter(id => !nextStaffStrings.includes(id))
            .map(id => toObjectId(id));

        await removeUsersFromOtherBranches({ branchId, managerId: nextManager, staffIds: nextStaffs });

        branch.manager = nextManager;
        branch.staffs = nextStaffs;
        branch.isActive = nextIsActive;
        await branch.save();

        await syncStaffManagers(nextStaffs, nextManager);
        await syncStaffManagers(removedStaffs, null);
        if (data.name && data.name.trim().replace(/\s+/g, ' ') !== oldName) {
            await logBranchActivity({
                req,
                type: 'branch_updated',
                branchName: branch.name,
                message: `renamed branch "${oldName}" to "${branch.name}"`,
            });
        }
        if (nextManager && String(nextManager) !== oldManager) {
            const manager = await User.findById(nextManager, { username: true }).lean();
            await logBranchActivity({
                req,
                type: 'branch_updated',
                branchName: branch.name,
                message: `updated manager for branch "${branch.name}" to ${manager?.username ?? 'Unknown manager'}`,
            });
        }
        if (removedStaffs.length > 0) {
            await logBranchActivity({
                req,
                type: 'branch_staff_removed',
                branchName: branch.name,
                message: `removed staff ${(await getUsernames(removedStaffs)).join(', ')} from branch "${branch.name}"`,
            });
        }
        const addedStaffs = nextStaffs.filter(id => !previousStaffs.includes(String(id)));
        if (addedStaffs.length > 0) {
            await logBranchActivity({
                req,
                type: conflicts.length > 0 ? 'branch_staff_transferred' : 'branch_staff_added',
                branchName: branch.name,
                message: `${conflicts.length > 0 ? 'transferred' : 'added'} staff ${(await getUsernames(addedStaffs)).join(', ')} to branch "${branch.name}"`,
            });
        }
        if (typeof data.isActive !== 'undefined' && data.isActive !== oldIsActive) {
            await logBranchActivity({
                req,
                type: data.isActive ? 'branch_activated' : 'branch_inactivated',
                branchName: branch.name,
                message: `${data.isActive ? 'made active' : 'made inactive'} branch "${branch.name}"`,
            });
        }
        if (data.location && (!oldLocation ||
            oldLocation.latitude !== data.location.latitude ||
            oldLocation.longitude !== data.location.longitude)) {
            await logBranchActivity({
                req,
                type: 'branch_location_updated',
                branchName: branch.name,
                message: `updated location for branch "${branch.name}" to ${data.location.latitude}, ${data.location.longitude}`,
            });
        }

        res.status(200).json(await serializeBranch(branch._id));
    } catch (e) {
        onCatchError(e, res);
    }
});

export const addStaffToBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        ensureAdmin(req);
        const branchId = toObjectId(ObjectIdSchema.parse(req.params.id));
        const data = addStaffSchema.parse(req.body);
        const branch = await Branch.findById(branchId);
        if (!branch) throw new AppError('Branch not found', 404);
        if (!branch.isActive) throw new AppError('Cannot assign staff to an inactive branch', 400);
        if (!branch.manager) throw new AppError('Branch requires a manager before assigning staff', 400);

        const staffIds = uniqueObjectIds(data.staffIds);
        for (const staffId of staffIds) await assertUserRole(staffId, 'staff');

        const conflicts = await findMembershipConflicts({ branchId, staffIds });
        if (!data.confirmMove) throwConflicts(conflicts, branch);

        await removeUsersFromOtherBranches({ branchId, staffIds });
        const allStaffIds = uniqueObjectIds([...branch.staffs, ...staffIds]);
        branch.staffs = allStaffIds;
        await branch.save();
        await syncStaffManagers(staffIds, branch.manager);
        await logBranchActivity({
            req,
            type: conflicts.length > 0 ? 'branch_staff_transferred' : 'branch_staff_added',
            branchName: branch.name,
            message: `${conflicts.length > 0 ? 'transferred' : 'added'} staff ${(await getUsernames(staffIds)).join(', ')} to branch "${branch.name}"`,
        });

        res.status(200).json(await serializeBranch(branch._id));
    } catch (e) {
        onCatchError(e, res);
    }
});

export const removeStaffFromBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        ensureAdmin(req);
        const branchId = toObjectId(ObjectIdSchema.parse(req.params.id));
        const staffId = toObjectId(ObjectIdSchema.parse(req.params.staffId));
        const branch = await Branch.findById(branchId);
        if (!branch) throw new AppError('Branch not found', 404);

        branch.staffs = branch.staffs.filter(id => String(id) !== String(staffId));
        await branch.save();
        await syncStaffManagers([staffId], null);
        await logBranchActivity({
            req,
            type: 'branch_staff_removed',
            branchName: branch.name,
            message: `removed staff ${(await getUsernames([staffId])).join(', ')} from branch "${branch.name}"`,
        });

        res.status(200).json(await serializeBranch(branch._id));
    } catch (e) {
        onCatchError(e, res);
    }
});
