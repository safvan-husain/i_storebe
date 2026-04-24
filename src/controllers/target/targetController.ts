import asyncHandler from "express-async-handler";
import { Request } from "express";
import Target, { ITarget } from "../../models/Target";
import { onCatchError } from "../../middleware/error";
import { getMonthOnly, TargetCreateSchema, TargetFilterSchema } from "./validation";
import User from "../../models/User";
import Branch from "../../models/Branch";
import BranchMembership from "../../models/BranchMembership";
import { FilterQuery, ObjectId, Types } from "mongoose";
import { ILead } from "../../models/Lead";
import { TypedResponse } from "../../common/interface";
import { UserPrivilegeSchema } from "../../common/types";
import { getCurrentBranchIdForUser } from "../../services/branch-context";

interface SingleTargetStat {
    total: number;
    achieved: number;
    username: string;
    userId?: string;
    branchId?: string;
    membershipStatus?: 'active' | 'transferred' | 'removed';
    childStats: SingleTargetStat[];
}

interface TargetStatResponse {
    overall: { total: number, achieved: number };
    stats: SingleTargetStat[];
}

const toObjectId = (id: string | Types.ObjectId) =>
    typeof id === 'string' ? Types.ObjectId.createFromHexString(id) : id;

const getMonthEnd = (month: Date) => {
    const end = new Date(month);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
    return end;
};

const ensureBranchTarget = async (branch: Types.ObjectId, month: Date) => {
    let target = await Target.findOne({ scope: 'branch', branch, month });
    if (!target) {
        target = await Target.create({
            scope: 'branch',
            branch,
            month,
            total: 0,
            achieved: 0,
        });
    }
    return target;
};

const ensureAllocationTarget = async (branch: Types.ObjectId, assigned: Types.ObjectId, month: Date) => {
    const parentTarget = await ensureBranchTarget(branch, month);
    let target = await Target.findOne({ scope: 'allocation', branch, assigned, month });
    if (!target) {
        target = await Target.create({
            scope: 'allocation',
            branch,
            assigned,
            month,
            parentTarget: parentTarget._id,
            total: 0,
            achieved: 0,
        });
    }
    return target;
};

const incrementTargetAchievedCount = async (userId: ObjectId | Types.ObjectId, branchId?: Types.ObjectId) => {
    const month = getMonthOnly();
    const branch = branchId ?? await getCurrentBranchIdForUser(userId as any);

    await Target.findOneAndUpdate(
        { assigned: userId, month, scope: { $in: ['legacy', undefined as any] } },
        { $inc: { achieved: 1 }, $setOnInsert: { total: 0, scope: 'legacy' } },
        { upsert: true }
    );

    if (!branch) return;
    await ensureBranchTarget(branch, month);
    await Target.findOneAndUpdate(
        { scope: 'branch', branch, month },
        { $inc: { achieved: 1 } }
    );
    await ensureAllocationTarget(branch, userId as Types.ObjectId, month);
    await Target.findOneAndUpdate(
        { scope: 'allocation', branch, assigned: userId, month },
        { $inc: { achieved: 1 } }
    );
};

const decrementTargetAchievedCount = async (userId: ObjectId | Types.ObjectId, branchId?: Types.ObjectId) => {
    const month = getMonthOnly();
    const branch = branchId ?? await getCurrentBranchIdForUser(userId as any);

    await Target.findOneAndUpdate(
        { assigned: userId, month, scope: { $in: ['legacy', undefined as any] } },
        { $inc: { achieved: -1 }, $setOnInsert: { total: 0, scope: 'legacy' } },
        { upsert: true }
    );

    if (!branch) return;
    await ensureBranchTarget(branch, month);
    await Target.findOneAndUpdate(
        { scope: 'branch', branch, month },
        { $inc: { achieved: -1 } }
    );
    await ensureAllocationTarget(branch, userId as Types.ObjectId, month);
    await Target.findOneAndUpdate(
        { scope: 'allocation', branch, assigned: userId, month },
        { $inc: { achieved: -1 } }
    );
};

export const handleTarget = async ({
    updater,
    lead,
    type,
}: {
    updater: ObjectId,
    lead: ILead<Types.ObjectId, any>,
    type: 'increment' | 'decrement'
}) => {
    const delta = type === 'increment' ? incrementTargetAchievedCount : decrementTargetAchievedCount;
    const updaterBranch = (type === 'increment' ? lead.wonBranch : lead.wonBranch) as Types.ObjectId | undefined;
    await delta(updater as unknown as Types.ObjectId, updaterBranch);

    if (updater.toString() === lead.createdBy.toString()) return;

    const creator = await User.findById(lead.createdBy, { secondPrivilege: true }).lean();
    if (creator?.secondPrivilege !== 'call-center') return;

    await delta(
        lead.createdBy as unknown as Types.ObjectId,
        lead.createdBranch as Types.ObjectId | undefined
    );
};

export const createTarget = asyncHandler(
    async (req: Request, res: TypedResponse<undefined>) => {
        try {
            if (!['admin', 'manager'].includes(req.privilege)) {
                res.status(403).json({ message: "Require admin or manager privilege to create target" });
                return;
            }

            const data = TargetCreateSchema.parse(req.body);
            const branchId = data.branchId ?? data.branch;

            if (branchId) {
                const branch = await Branch.findById(branchId, { manager: true, staffs: true }).lean();
                if (!branch) {
                    res.status(404).json({ message: "Branch not found" });
                    return;
                }
                if (req.privilege === 'manager' && String(branch.manager) !== req.userId) {
                    res.status(403).json({ message: "Manager can only create target for own branch" });
                    return;
                }

                const branchObjectId = toObjectId(branchId);
                const branchTarget = await ensureBranchTarget(branchObjectId, data.month);
                branchTarget.total = data.total;
                await branchTarget.save();

                for (const allocation of data.allocations ?? []) {
                    const assigned = toObjectId(allocation.assigned);
                    const target = await ensureAllocationTarget(branchObjectId, assigned, data.month);
                    target.total = allocation.total;
                    target.parentTarget = branchTarget._id as Types.ObjectId;
                    await target.save();
                }

                res.status(200).json({ message: "target updated" });
                return;
            }

            if (!data.assigned) {
                res.status(400).json({ message: "assigned is required" });
                return;
            }

            const assignedUser = await User.findById(data.assigned, { privilege: true }).lean();
            if (!assignedUser) {
                res.status(404).json({ message: "assigned not found on db" });
                return;
            }

            if (req.privilege === 'admin' && assignedUser.privilege !== 'manager') {
                res.status(400).json({ message: "Admin can only create target for manager" });
                return;
            }

            if (req.privilege === 'manager' && assignedUser.privilege !== 'staff') {
                res.status(400).json({ message: "Manager can only create target for staff" });
                return;
            }

            const assigned = toObjectId(data.assigned);
            const branch = await getCurrentBranchIdForUser(assigned);
            if (assignedUser.privilege === 'manager' && branch) {
                const branchTarget = await ensureBranchTarget(branch, data.month);
                branchTarget.total = data.total;
                await branchTarget.save();
                res.status(200).json({ message: "target updated" });
                return;
            }

            if (branch) {
                const allocation = await ensureAllocationTarget(branch, assigned, data.month);
                allocation.total = data.total;
                await allocation.save();
            }

            let target = await Target.findOne({ assigned: data.assigned, month: data.month, scope: { $in: ['legacy', undefined as any] } });
            if (!target) {
                await Target.create({ assigned: data.assigned, month: data.month, total: data.total, achieved: 0, scope: 'legacy' });
            } else {
                target.total = data.total;
                await target.save();
            }
            res.status(200).json({ message: "target updated" });
        } catch (e) {
            onCatchError(e, res);
        }
    });

const getBranchesForRequest = async (req: Request, branchId?: string) => {
    if (branchId) {
        return Branch.find({ _id: toObjectId(branchId) }).lean();
    }
    if (req.privilege === UserPrivilegeSchema.enum.manager) {
        return Branch.find({ manager: toObjectId(req.userId!) }).lean();
    }
    if (req.privilege === UserPrivilegeSchema.enum.staff) {
        return Branch.find({ staffs: toObjectId(req.userId!) }).lean();
    }
    return Branch.find().sort({ name: 1 }).lean();
};

const getBranchTargetStats = async (req: Request, month: Date, branchId?: string): Promise<TargetStatResponse> => {
    const branches = await getBranchesForRequest(req, branchId);
    const monthEnd = getMonthEnd(month);
    const stats: SingleTargetStat[] = [];

    for (const branch of branches) {
        const branchTarget = await Target.findOne({ scope: 'branch', branch: branch._id, month }).lean();
        const allocations = await Target.find({ scope: 'allocation', branch: branch._id, month })
            .populate<{ assigned?: { username: string } }>('assigned', 'username')
            .lean();
        const memberships = await BranchMembership.find({
            branch: branch._id,
            startedAt: { $lte: monthEnd },
            $or: [
                { endedAt: { $exists: false } },
                { endedAt: { $gte: month } },
            ],
        }).populate<{ user?: { username: string } }>('user', 'username').lean();

        const rows = new Map<string, SingleTargetStat>();
        const currentUsers = new Set([
            ...(branch.manager ? [String(branch.manager)] : []),
            ...(branch.staffs ?? []).map(id => String(id)),
        ]);

        for (const membership of memberships) {
            const membershipUser = membership.user as any;
            const userId = String(membershipUser?._id ?? membership.user);
            rows.set(userId, {
                username: (membership.user as any)?.username ?? 'Unknown',
                userId,
                total: 0,
                achieved: 0,
                membershipStatus: currentUsers.has(userId)
                    ? 'active'
                    : (membership.endReason === 'removed' ? 'removed' : 'transferred'),
                childStats: [],
            });
        }

        for (const allocation of allocations) {
            const userId = String((allocation.assigned as any)?._id ?? allocation.assigned);
            const existing = rows.get(userId);
            rows.set(userId, {
                username: (allocation.assigned as any)?.username ?? existing?.username ?? 'Unknown',
                userId,
                total: allocation.total,
                achieved: allocation.achieved,
                membershipStatus: existing?.membershipStatus ?? (currentUsers.has(userId) ? 'active' : 'transferred'),
                childStats: [],
            });
        }

        stats.push({
            username: branch.name,
            branchId: String(branch._id),
            total: branchTarget?.total ?? 0,
            achieved: branchTarget?.achieved ?? allocations.reduce((sum, item) => sum + item.achieved, 0),
            childStats: [...rows.values()].sort((a, b) => a.username.localeCompare(b.username)),
        });
    }

    return {
        overall: {
            total: stats.reduce((sum, item) => sum + item.total, 0),
            achieved: stats.reduce((sum, item) => sum + item.achieved, 0),
        },
        stats,
    };
};

const getLegacyTargetStats = async (query: FilterQuery<ITarget>): Promise<TargetStatResponse> => {
    const targets = await Target.find({ ...query, scope: { $in: ['legacy', undefined as any] } })
        .populate<{ assigned?: { username: string } }>('assigned', 'username')
        .lean();

    return {
        overall: {
            total: targets.reduce((sum, item) => sum + item.total, 0),
            achieved: targets.reduce((sum, item) => sum + item.achieved, 0),
        },
        stats: targets.map(item => ({
            username: (item.assigned as any)?.username ?? 'Unknown',
            userId: String((item.assigned as any)?._id ?? item.assigned),
            total: item.total,
            achieved: item.achieved,
            childStats: [],
        })),
    };
};

export const getTarget = asyncHandler(
    async (req: Request, res: TypedResponse<TargetStatResponse>) => {
        try {
            if (!req.userId) {
                res.status(403).json({ message: "user id not found" });
                return;
            }

            const filter = TargetFilterSchema.parse(req.query);
            const branchId = filter.branchId ?? filter.branch;
            const branchStats = await getBranchTargetStats(req, filter.month, branchId);

            if (branchStats.stats.length > 0 || branchId || req.privilege !== UserPrivilegeSchema.enum.staff) {
                res.status(200).json(branchStats);
                return;
            }

            const query: FilterQuery<ITarget> = { month: filter.month };
            if (req.privilege === UserPrivilegeSchema.enum.staff) {
                query.assigned = Types.ObjectId.createFromHexString(req.userId);
            }
            res.status(200).json(await getLegacyTargetStats(query));
        } catch (e) {
            onCatchError(e, res);
        }
    });
