import { Types } from 'mongoose';
import Branch from '../models/Branch';

export type UserBranchSummary = { _id: string; name: string };

export const getBranchMapForUsers = async (
    userIds: string[],
): Promise<Map<string, UserBranchSummary>> => {
    if (userIds.length === 0) return new Map<string, UserBranchSummary>();
    const objectIds = userIds.map(id => Types.ObjectId.createFromHexString(id));
    const branches = await Branch.find({
        $or: [
            { manager: { $in: objectIds } },
            { staffs: { $in: objectIds } },
        ],
    }, { name: true, manager: true, staffs: true }).lean();

    const branchMap = new Map<string, UserBranchSummary>();
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
