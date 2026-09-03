import { FilterQuery, Types } from 'mongoose';
import Activity from '../models/Activity';
import Branch, { IBranch } from '../models/Branch';
import User from '../models/User';
import Lead from '../models/Lead';
import Task from '../models/Task';
import { AppError } from '../middleware/error';
import { ObjectIdSchema, UserPrivilegeSchema } from '../common/types';
import { closeOpenMembershipsForUsers, syncOpenMembershipsForBranch } from './branch-context';
import {
    addStaffSchema,
    createBranchSchema,
    updateBranchSchema,
} from '../controllers/branch/validation';

const normalizeBranchName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

type BranchActivityType =
    | 'branch_created'
    | 'branch_updated'
    | 'branch_staff_added'
    | 'branch_staff_removed'
    | 'branch_staff_transferred'
    | 'branch_location_updated'
    | 'branch_activated'
    | 'branch_inactivated'
    | 'branch_attendance_enabled'
    | 'branch_attendance_disabled';

type Actor = {
    userId?: string;
    username?: string;
    privilege?: string;
    secondPrivilege?: string;
};

const ensureAdmin = (actor: Actor) => {
    if (actor.privilege !== UserPrivilegeSchema.enum.admin) {
        throw new AppError('Only admins can manage branches', 403);
    }
};

const ensureAdminOrHr = (actor: Actor) => {
    if (actor.privilege === UserPrivilegeSchema.enum.admin || actor.secondPrivilege === 'hr') {
        return;
    }
    throw new AppError('Only admins or HR can view branches', 403);
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
        await handOverStaffFromOtherBranches({ branchId, staffIds });
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

// Ownership handover intentionally preserves historical attribution fields.
const handOverOpenWork = async ({ staffId, sourceBranch }: {
    staffId: Types.ObjectId;
    sourceBranch: IBranch;
}) => {
    if (!sourceBranch.manager) {
        throw new AppError(`Branch "${sourceBranch.name}" requires a manager before staff can be moved or removed`, 400);
    }
    const managerId = sourceBranch.manager as Types.ObjectId;
    const leads = await Lead.find({ handledBy: staffId, enquireStatus: { $ne: 'won' } }, { _id: true }).lean();
    const leadIds = leads.map(lead => lead._id);
    if (leadIds.length === 0) return;
    await Lead.updateMany(
        { _id: { $in: leadIds } },
        { $set: { handledBy: managerId, manager: managerId, handlingBranch: sourceBranch._id } },
    );
    await Task.updateMany(
        { lead: { $in: leadIds }, isCompleted: false },
        { $set: { assigned: managerId } },
    );
};

const handOverStaffFromOtherBranches = async ({ branchId, staffIds }: {
    branchId: Types.ObjectId;
    staffIds?: Types.ObjectId[];
}) => {
    if (!staffIds?.length) return;
    const sources = await Branch.find({ _id: { $ne: branchId }, staffs: { $in: staffIds } });
    for (const source of sources) {
        if (!source.manager) throw new AppError(`Branch "${source.name}" requires a manager before staff can be moved`, 400);
    }
    for (const source of sources) {
        for (const staffId of staffIds) {
            if (source.staffs.some(id => String(id) === String(staffId))) {
                await handOverOpenWork({ staffId, sourceBranch: source });
            }
        }
    }
};

const getUsernames = async (ids: Types.ObjectId[]) => {
    if (ids.length === 0) return [];
    const users = await User.find({ _id: { $in: ids } }, { username: true }).lean();
    return users.map(user => user.username);
};

const logBranchActivity = async ({
    actor,
    type,
    branchName,
    message,
}: {
    actor: Actor;
    type: BranchActivityType;
    branchName: string;
    message: string;
}) => {
    if (!actor.userId) return;
    await Activity.createActivity({
        activator: toObjectId(actor.userId),
        type,
        action: `${actor.username ?? 'Admin'} ${message}`,
        optionalMessage: `Branch: ${branchName}`,
    });
};

const serializeBranch = async (branchId: Types.ObjectId | string) => {
    return Branch.findById(branchId)
        .populate('manager', 'username privilege secondPrivilege isActive')
        .populate('staffs', 'username privilege secondPrivilege isActive')
        .lean();
};

export const branchService = {
    async createBranch(actor: Actor, payload: unknown) {
        ensureAdmin(actor);
        if (!actor.userId) throw new AppError('User id not found', 401);

        const data = createBranchSchema.parse(payload);
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
                updatedBy: toObjectId(actor.userId),
            } : undefined,
            isActive: data.isActive,
            attendanceEnabled: data.attendanceEnabled,
            createdBy: toObjectId(actor.userId),
        });

        await removeUsersFromOtherBranches({ branchId: branch._id, managerId, staffIds });
        if (staffIds.length > 0) await syncStaffManagers(staffIds, managerId);
        await syncOpenMembershipsForBranch({
            branch: branch._id,
            manager: managerId,
            staffs: staffIds,
            actor: toObjectId(actor.userId),
            startedAt: branch.createdAt,
        });
        const manager = managerId ? await User.findById(managerId, { username: true }).lean() : null;
        await logBranchActivity({
            actor,
            type: 'branch_created',
            branchName: branch.name,
            message: `created branch "${branch.name}"${manager ? ` with manager ${manager.username}` : ''}`,
        });
        if (staffIds.length > 0) {
            await logBranchActivity({
                actor,
                type: conflicts.length > 0 ? 'branch_staff_transferred' : 'branch_staff_added',
                branchName: branch.name,
                message: `${conflicts.length > 0 ? 'transferred' : 'added'} staff ${((await getUsernames(staffIds)).join(', '))} to branch "${branch.name}"`,
            });
        }
        if (data.location) {
            await logBranchActivity({
                actor,
                type: 'branch_location_updated',
                branchName: branch.name,
                message: `set location for branch "${branch.name}" to ${data.location.latitude}, ${data.location.longitude}`,
            });
        }

        return serializeBranch(branch._id);
    },

    async getBranches(actor: Actor) {
        ensureAdminOrHr(actor);
        return Branch.find()
            .sort({ isActive: -1, name: 1 })
            .populate('manager', 'username privilege secondPrivilege isActive')
            .populate('staffs', 'username privilege secondPrivilege isActive')
            .lean();
    },

    async getBranchById(actor: Actor, branchIdParam: string) {
        ensureAdmin(actor);
        const branchId = ObjectIdSchema.parse(branchIdParam);
        const branch = await serializeBranch(branchId);
        if (!branch) throw new AppError('Branch not found', 404);
        return branch;
    },

    async updateBranch(actor: Actor, branchIdParam: string, payload: unknown) {
        ensureAdmin(actor);
        if (!actor.userId) throw new AppError('User id not found', 401);

        const branchId = toObjectId(ObjectIdSchema.parse(branchIdParam));
        const data = updateBranchSchema.parse(payload);

        const branch = await Branch.findById(branchId);
        if (!branch) throw new AppError('Branch not found', 404);
        const oldName = branch.name;
        const oldManager = branch.manager ? String(branch.manager) : undefined;
        const oldIsActive = branch.isActive;
        const oldAttendanceEnabled = branch.attendanceEnabled;
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
                updatedBy: toObjectId(actor.userId),
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
        const managerChanged = String(nextManager ?? '') !== String(oldManager ?? '');

        for (const staffId of removedStaffs) await handOverOpenWork({ staffId, sourceBranch: branch });
        await removeUsersFromOtherBranches({ branchId, managerId: nextManager, staffIds: nextStaffs });

        branch.manager = nextManager;
        branch.staffs = nextStaffs;
        branch.isActive = nextIsActive;
        if (typeof data.attendanceEnabled !== 'undefined') {
            branch.attendanceEnabled = data.attendanceEnabled;
        }
        await branch.save();

        await syncStaffManagers(nextStaffs, nextManager);
        await syncStaffManagers(removedStaffs, null);
        if (managerChanged && oldManager) {
            await closeOpenMembershipsForUsers({
                users: [toObjectId(oldManager)],
                endedBy: toObjectId(actor.userId),
                endReason: 'manager_changed',
            });
        }
        await syncOpenMembershipsForBranch({
            branch: branch._id,
            manager: branch.manager,
            staffs: branch.staffs,
            actor: toObjectId(actor.userId),
            removedReason: 'removed',
        });
        if (data.name && data.name.trim().replace(/\s+/g, ' ') !== oldName) {
            await logBranchActivity({
                actor,
                type: 'branch_updated',
                branchName: branch.name,
                message: `renamed branch "${oldName}" to "${branch.name}"`,
            });
        }
        if (nextManager && String(nextManager) !== oldManager) {
            const manager = await User.findById(nextManager, { username: true }).lean();
            await logBranchActivity({
                actor,
                type: 'branch_updated',
                branchName: branch.name,
                message: `updated manager for branch "${branch.name}" to ${manager?.username ?? 'Unknown manager'}`,
            });
        }
        if (removedStaffs.length > 0) {
            await logBranchActivity({
                actor,
                type: 'branch_staff_removed',
                branchName: branch.name,
                message: `removed staff ${(await getUsernames(removedStaffs)).join(', ')} from branch "${branch.name}"`,
            });
        }
        const addedStaffs = nextStaffs.filter(id => !previousStaffs.includes(String(id)));
        if (addedStaffs.length > 0) {
            await logBranchActivity({
                actor,
                type: conflicts.length > 0 ? 'branch_staff_transferred' : 'branch_staff_added',
                branchName: branch.name,
                message: `${conflicts.length > 0 ? 'transferred' : 'added'} staff ${(await getUsernames(addedStaffs)).join(', ')} to branch "${branch.name}"`,
            });
        }
        if (typeof data.isActive !== 'undefined' && data.isActive !== oldIsActive) {
            await logBranchActivity({
                actor,
                type: data.isActive ? 'branch_activated' : 'branch_inactivated',
                branchName: branch.name,
                message: `${data.isActive ? 'made active' : 'made inactive'} branch "${branch.name}"`,
            });
        }
        if (typeof data.attendanceEnabled !== 'undefined' && data.attendanceEnabled !== oldAttendanceEnabled) {
            await logBranchActivity({
                actor,
                type: data.attendanceEnabled ? 'branch_attendance_enabled' : 'branch_attendance_disabled',
                branchName: branch.name,
                message: `${data.attendanceEnabled ? 'enabled' : 'disabled'} attendance for branch "${branch.name}"`,
            });
        }
        if (data.location && (!oldLocation ||
            oldLocation.latitude !== data.location.latitude ||
            oldLocation.longitude !== data.location.longitude)) {
            await logBranchActivity({
                actor,
                type: 'branch_location_updated',
                branchName: branch.name,
                message: `updated location for branch "${branch.name}" to ${data.location.latitude}, ${data.location.longitude}`,
            });
        }

        return serializeBranch(branch._id);
    },

    async addStaffToBranch(actor: Actor, branchIdParam: string, payload: unknown) {
        ensureAdmin(actor);
        if (!actor.userId) throw new AppError('User id not found', 401);
        const branchId = toObjectId(ObjectIdSchema.parse(branchIdParam));
        const data = addStaffSchema.parse(payload);
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
        await syncOpenMembershipsForBranch({
            branch: branch._id,
            manager: branch.manager,
            staffs: branch.staffs,
            actor: toObjectId(actor.userId),
        });
        await logBranchActivity({
            actor,
            type: conflicts.length > 0 ? 'branch_staff_transferred' : 'branch_staff_added',
            branchName: branch.name,
            message: `${conflicts.length > 0 ? 'transferred' : 'added'} staff ${(await getUsernames(staffIds)).join(', ')} to branch "${branch.name}"`,
        });

        return serializeBranch(branch._id);
    },

    async removeStaffFromBranch(actor: Actor, branchIdParam: string, staffIdParam: string) {
        ensureAdmin(actor);
        if (!actor.userId) throw new AppError('User id not found', 401);
        const branchId = toObjectId(ObjectIdSchema.parse(branchIdParam));
        const staffId = toObjectId(ObjectIdSchema.parse(staffIdParam));
        const branch = await Branch.findById(branchId);
        if (!branch) throw new AppError('Branch not found', 404);

        if (branch.staffs.some(id => String(id) === String(staffId))) {
            await handOverOpenWork({ staffId, sourceBranch: branch });
        }

        branch.staffs = branch.staffs.filter(id => String(id) !== String(staffId));
        await branch.save();
        await syncStaffManagers([staffId], null);
        await syncOpenMembershipsForBranch({
            branch: branch._id,
            manager: branch.manager,
            staffs: branch.staffs,
            actor: toObjectId(actor.userId),
            removedReason: 'removed',
        });
        await logBranchActivity({
            actor,
            type: 'branch_staff_removed',
            branchName: branch.name,
            message: `removed staff ${(await getUsernames([staffId])).join(', ')} from branch "${branch.name}"`,
        });

        return serializeBranch(branch._id);
    },
};
