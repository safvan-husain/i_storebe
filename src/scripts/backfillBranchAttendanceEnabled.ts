import 'dotenv/config';
import mongoose from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';

type Args = {
    dryRun: boolean;
    apply: boolean;
};

const ATTENDANCE_ENABLED_BRANCH_NORMALIZED_NAME = '19th mile';

const parseArgs = (): Args => {
    const args = new Set(process.argv.slice(2));
    return {
        dryRun: args.has('--dry-run') || !args.has('--apply'),
        apply: args.has('--apply'),
    };
};

const normalizeBranchName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export const backfillBranchAttendanceEnabled = async (args: Args) => {
    const branches = await Branch.find({}, { name: true, normalizedName: true, attendanceEnabled: true }).lean();
    const summary = {
        mode: args.apply ? 'apply' as const : 'dry-run' as const,
        totalBranches: branches.length,
        disabled: [] as Array<{ branchId: string; branchName: string }>,
        enabled: [] as Array<{ branchId: string; branchName: string }>,
        unchanged: [] as Array<{ branchId: string; branchName: string; attendanceEnabled: boolean }>,
    };

    for (const branch of branches) {
        const normalizedName = branch.normalizedName ?? normalizeBranchName(branch.name);
        const nextAttendanceEnabled = normalizedName === ATTENDANCE_ENABLED_BRANCH_NORMALIZED_NAME;
        const currentAttendanceEnabled = branch.attendanceEnabled === true;

        if (currentAttendanceEnabled === nextAttendanceEnabled) {
            summary.unchanged.push({
                branchId: String(branch._id),
                branchName: branch.name,
                attendanceEnabled: currentAttendanceEnabled,
            });
            continue;
        }

        const entry = {
            branchId: String(branch._id),
            branchName: branch.name,
        };

        if (nextAttendanceEnabled) {
            summary.enabled.push(entry);
        } else {
            summary.disabled.push(entry);
        }

        if (args.apply) {
            await Branch.updateOne(
                { _id: branch._id },
                { $set: { attendanceEnabled: nextAttendanceEnabled } },
            );
        }
    }

    return summary;
};

const run = async () => {
    const args = parseArgs();
    await connectDb();
    const result = await backfillBranchAttendanceEnabled(args);
    console.log(JSON.stringify(result, null, 2));
    await mongoose.connection.close();
};

if (require.main === module) {
    run().catch(async error => {
        console.error(error);
        try { await mongoose.connection.close(); } catch {}
        process.exit(1);
    });
}
