import { FilterQuery, Types } from 'mongoose';
import Branch from '../models/Branch';
import BranchMembership, {
    BranchMembershipEndReason,
    BranchMembershipRole,
} from '../models/BranchMembership';

type MembershipUser = {
    user: Types.ObjectId;
    role: BranchMembershipRole;
};

export const getCurrentBranchForUser = async (userId?: string | Types.ObjectId | null) => {
    if (!userId) return null;
    const objectId = typeof userId === 'string'
        ? Types.ObjectId.createFromHexString(userId)
        : userId;

    return Branch.findOne({
        $or: [
            { manager: objectId },
            { staffs: objectId },
        ],
    }, { _id: true, name: true }).lean();
};

export const getCurrentBranchIdForUser = async (userId?: string | Types.ObjectId | null) => {
    const branch = await getCurrentBranchForUser(userId);
    return branch?._id ?? undefined;
};

export const getCurrentBranchIdFromCandidates = async (
    userIds: Array<string | Types.ObjectId | null | undefined>
) => {
    for (const userId of userIds) {
        const branchId = await getCurrentBranchIdForUser(userId);
        if (branchId) return branchId;
    }
    return undefined;
};

export const closeOpenMembershipsForUsers = async ({
    users,
    endedBy,
    endReason,
    excludeBranch,
    endedAt = new Date(),
}: {
    users: Types.ObjectId[];
    endedBy?: Types.ObjectId;
    endReason: BranchMembershipEndReason;
    excludeBranch?: Types.ObjectId;
    endedAt?: Date;
}) => {
    if (users.length === 0) return;

    const query: FilterQuery<any> = {
        user: { $in: users },
        endedAt: { $exists: false },
    };
    if (excludeBranch) query.branch = { $ne: excludeBranch };

    await BranchMembership.updateMany(query, {
        $set: {
            endedAt,
            endedBy,
            endReason,
        },
    });
};

export const openMemberships = async ({
    branch,
    memberships,
    startedBy,
    startedAt = new Date(),
}: {
    branch: Types.ObjectId;
    memberships: MembershipUser[];
    startedBy?: Types.ObjectId;
    startedAt?: Date;
}) => {
    for (const membership of memberships) {
        const existing = await BranchMembership.findOne({
            branch,
            user: membership.user,
            role: membership.role,
            endedAt: { $exists: false },
        }, { _id: true }).lean();
        if (existing) continue;

        await BranchMembership.create({
            branch,
            user: membership.user,
            role: membership.role,
            startedAt,
            startedBy,
        });
    }
};

export const syncOpenMembershipsForBranch = async ({
    branch,
    manager,
    staffs,
    actor,
    removedReason = 'removed',
    startedAt = new Date(),
}: {
    branch: Types.ObjectId;
    manager?: Types.ObjectId | null;
    staffs: Types.ObjectId[];
    actor?: Types.ObjectId;
    removedReason?: BranchMembershipEndReason;
    startedAt?: Date;
}) => {
    const desired = new Map<string, MembershipUser>();
    if (manager) desired.set(String(manager), { user: manager, role: 'manager' });
    for (const staff of staffs) desired.set(String(staff), { user: staff, role: 'staff' });

    const desiredUsers = [...desired.values()].map(item => item.user);
    await closeOpenMembershipsForUsers({
        users: desiredUsers,
        endedBy: actor,
        endReason: 'transferred',
        excludeBranch: branch,
    });

    const openForBranch = await BranchMembership.find({
        branch,
        endedAt: { $exists: false },
    }).lean();

    const stillDesired = new Set([...desired.keys()]);
    const toClose = openForBranch
        .filter(item => !stillDesired.has(String(item.user)))
        .map(item => item.user);
    await closeOpenMembershipsForUsers({
        users: toClose,
        endedBy: actor,
        endReason: removedReason,
    });

    await openMemberships({
        branch,
        memberships: [...desired.values()],
        startedBy: actor,
        startedAt,
    });
};

export const getBranchMembershipUsersForRange = async ({
    branch,
    startDate,
    endDate,
}: {
    branch: Types.ObjectId;
    startDate: Date;
    endDate: Date;
}) => {
    return BranchMembership.find({
        branch,
        startedAt: { $lte: endDate },
        $or: [
            { endedAt: { $exists: false } },
            { endedAt: { $gte: startDate } },
        ],
    }).lean();
};
