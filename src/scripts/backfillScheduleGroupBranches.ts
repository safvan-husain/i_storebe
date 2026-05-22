import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import {
    AttendanceScheduleGroup,
    AttendanceScheduleGroupMembership,
} from '../models/AttendanceSchedule';

type Args = {
    dryRun: boolean;
    apply: boolean;
};

const parseArgs = (): Args => {
    const args = new Set(process.argv.slice(2));
    return {
        dryRun: args.has('--dry-run') || !args.has('--apply'),
        apply: args.has('--apply'),
    };
};

async function branchesForEmployees(employeeIds: Types.ObjectId[]) {
    if (employeeIds.length === 0) return [];
    return Branch.find({
        $or: [
            { manager: { $in: employeeIds } },
            { staffs: { $in: employeeIds } },
        ],
    }, { name: 1, manager: 1, staffs: 1 }).lean();
}

export const backfillScheduleGroupBranches = async (args: Args) => {
    const groups = await AttendanceScheduleGroup.find({ branch: { $exists: false } }).lean();
    const summary = {
        mode: args.apply ? 'apply' as const : 'dry-run' as const,
        totalGroups: groups.length,
        updated: [] as Array<{ groupId: string; groupName: string; branchId: string; branchName: string }>,
        skippedNoMembers: [] as Array<{ groupId: string; groupName: string }>,
        skippedCrossBranch: [] as Array<{ groupId: string; groupName: string; branchIds: string[] }>,
    };

    for (const group of groups) {
        const memberships = await AttendanceScheduleGroupMembership.find({
            group: group._id,
            isActive: true,
        }, { employee: 1 }).lean();
        const employeeIds = memberships.map((item) => new Types.ObjectId(String(item.employee)));
        if (employeeIds.length === 0) {
            summary.skippedNoMembers.push({
                groupId: String(group._id),
                groupName: group.name,
            });
            continue;
        }

        const branches = await branchesForEmployees(employeeIds);
        const branchIds = branches.map((branch) => String(branch._id));
        if (branchIds.length !== 1) {
            summary.skippedCrossBranch.push({
                groupId: String(group._id),
                groupName: group.name,
                branchIds,
            });
            continue;
        }

        const branch = branches[0];
        summary.updated.push({
            groupId: String(group._id),
            groupName: group.name,
            branchId: String(branch._id),
            branchName: branch.name,
        });

        if (args.apply) {
            await AttendanceScheduleGroup.updateOne(
                { _id: group._id },
                { $set: { branch: branch._id } },
            );
        }
    }

    return summary;
};

const run = async () => {
    const args = parseArgs();
    await connectDb();
    const result = await backfillScheduleGroupBranches(args);
    console.log(JSON.stringify(result, null, 2));
    await mongoose.connection.close();
};

if (require.main === module) {
    run().catch(async (error) => {
        console.error(error);
        try { await mongoose.connection.close(); } catch {}
        process.exit(1);
    });
}
