import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import AttendanceEvent from '../models/AttendanceEvent';
import AttendanceDailySnapshot from '../models/AttendanceDailySnapshot';
import AttendanceMonthlySummary from '../models/AttendanceMonthlySummary';
import { regenerateAttendanceDailySnapshot } from '../services/attendance-snapshot-maintenance';
import { branchLocalParts, isValidTimezone } from '../utils/branch_timezone';

type Args = {
    dryRun: boolean;
    apply: boolean;
    branchId?: string;
    branchName?: string;
    timezone: string;
    fixAttendance: boolean;
};

export type EventLocalFieldUpdate = {
    eventId: string;
    employeeId: string;
    previousBranchLocalDate: string;
    nextBranchLocalDate: string;
    previousBranchLocalTime: string;
    nextBranchLocalTime: string;
    previousBranchTimezone: string;
};

export type ChangeBranchTimezoneSummary = {
    mode: 'dry-run' | 'apply';
    branchId: string;
    branchName: string;
    previousTimezone: string;
    nextTimezone: string;
    fixAttendance: boolean;
    branchUpdated: boolean;
    eventUpdates: EventLocalFieldUpdate[];
    snapshotRegenerations: Array<{ employeeId: string; date: string }>;
    monthlySummaryRegenerations: Array<{ employeeId: string; month: string }>;
};

const normalizeBranchName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const parseArgs = (argv = process.argv.slice(2)): Args => {
    const args = new Set(argv);
    let branchId: string | undefined;
    let branchName: string | undefined;
    let timezone: string | undefined;

    const getVal = (index: number) => (index + 1 < argv.length ? argv[index + 1] : undefined);

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--branch-id') {
            branchId = getVal(i);
            i++;
            continue;
        }
        if (arg.startsWith('--branch-id=')) {
            branchId = arg.split('=')[1];
            continue;
        }
        if (arg === '--branch' || arg === '--branch-name') {
            branchName = getVal(i);
            i++;
            continue;
        }
        if (arg.startsWith('--branch=') || arg.startsWith('--branch-name=')) {
            branchName = arg.split('=')[1];
            continue;
        }
        if (arg === '--timezone' || arg === '-t') {
            timezone = getVal(i);
            i++;
            continue;
        }
        if (arg.startsWith('--timezone=')) {
            timezone = arg.split('=')[1];
            continue;
        }
    }

    return {
        dryRun: args.has('--dry-run') || !args.has('--apply'),
        apply: args.has('--apply'),
        branchId,
        branchName,
        timezone: timezone ?? 'Asia/Kolkata',
        fixAttendance: args.has('--fix-attendance'),
    };
};

const usage = () => {
    console.log('Usage: ts-node src/scripts/changeBranchTimezone.ts --branch <name> --timezone <iana-tz> [--fix-attendance] [--dry-run|--apply]');
    console.log('   or: ts-node src/scripts/changeBranchTimezone.ts --branch-id <id> --timezone <iana-tz> [--fix-attendance] [--dry-run|--apply]');
    console.log('');
    console.log('Examples:');
    console.log('  npm run change-branch-timezone -- --branch "Taliparamba" --timezone "Asia/Kolkata" --dry-run');
    console.log('  npm run change-branch-timezone -- --branch-id 665f1c2a3b4c5d6e7f8a9b0c --timezone "Asia/Kolkata" --fix-attendance --apply');
};

const findBranch = async (args: Pick<Args, 'branchId' | 'branchName'>) => {
    if (args.branchId) {
        if (!Types.ObjectId.isValid(args.branchId)) {
            throw new Error(`Invalid branch id: ${args.branchId}`);
        }
        const branch = await Branch.findById(args.branchId).lean();
        if (!branch) throw new Error(`Branch not found for id: ${args.branchId}`);
        return branch;
    }

    if (args.branchName) {
        const normalizedName = normalizeBranchName(args.branchName);
        const branch = await Branch.findOne({ normalizedName }).lean();
        if (!branch) throw new Error(`Branch not found for name: ${args.branchName}`);
        return branch;
    }

    throw new Error('Provide --branch or --branch-id');
};

const collectSnapshotDates = async (branchId: Types.ObjectId) => {
    const snapshots = await AttendanceDailySnapshot.find({ branch: branchId }, { employee: 1, date: 1 }).lean();
    return snapshots.map((snapshot) => ({
        employeeId: snapshot.employee as Types.ObjectId,
        date: snapshot.date,
    }));
};

const collectEventDates = async (branchId: Types.ObjectId) => {
    const events = await AttendanceEvent.find({ branch: branchId }, { employee: 1, branchLocalDate: 1 }).lean();
    const seen = new Set<string>();
    const dates: Array<{ employeeId: Types.ObjectId; date: string }> = [];
    for (const event of events) {
        const key = `${String(event.employee)}:${event.branchLocalDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dates.push({
            employeeId: event.employee as Types.ObjectId,
            date: event.branchLocalDate,
        });
    }
    return dates;
};

const monthFromDate = (date: string) => date.slice(0, 7);

const regenerateMonthlySummary = async (
    employeeId: Types.ObjectId,
    branchId: Types.ObjectId,
    month: string,
    branchTimezone: string,
) => {
    const snapshots = await AttendanceDailySnapshot.find({
        employee: employeeId,
        date: { $regex: `^${month}` },
    }).sort({ date: 1 });

    return AttendanceMonthlySummary.findOneAndUpdate(
        { employee: employeeId, month },
        {
            $set: {
                employee: employeeId,
                branch: branchId,
                month,
                branchTimezone,
                scheduledDays: snapshots.filter((snapshot) => snapshot.requiredWorkMinutes > 0).length,
                presentDays: snapshots.filter((snapshot) => snapshot.status === 'present').length,
                absentDays: snapshots.filter((snapshot) => snapshot.status === 'absent').length,
                offDays: snapshots.filter((snapshot) => snapshot.status === 'off_day').length,
                incompleteDays: snapshots.filter((snapshot) => ['incomplete', 'missing_checkout', 'open_break'].includes(snapshot.status)).length,
                requiredWorkMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.requiredWorkMinutes, 0),
                productiveWorkMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.productiveWorkMinutes, 0),
                grossMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.grossMinutes, 0),
                totalBreakMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.totalBreakMinutes, 0),
                breakOvertimeMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.breakOvertimeMinutes, 0),
                breakUndertimeMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.breakUndertimeMinutes, 0),
                overtimeMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.overtimeMinutes, 0),
                undertimeMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.undertimeMinutes, 0),
                lateMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.lateMinutes, 0),
                earlyLeaveMinutes: snapshots.reduce((sum, snapshot) => sum + snapshot.earlyLeaveMinutes, 0),
                generatedFromSnapshotIds: snapshots.map((snapshot) => snapshot._id),
                generatedAt: new Date(),
                version: 1,
            },
        },
        { new: true, upsert: true },
    );
};

export const changeBranchTimezone = async (args: Args): Promise<ChangeBranchTimezoneSummary> => {
    if (!isValidTimezone(args.timezone)) {
        throw new Error(`Invalid timezone: ${args.timezone}`);
    }

    const branch = await findBranch(args);
    const branchId = branch._id as Types.ObjectId;
    const summary: ChangeBranchTimezoneSummary = {
        mode: args.apply ? 'apply' : 'dry-run',
        branchId: String(branchId),
        branchName: branch.name,
        previousTimezone: branch.timezone,
        nextTimezone: args.timezone,
        fixAttendance: args.fixAttendance,
        branchUpdated: branch.timezone !== args.timezone,
        eventUpdates: [],
        snapshotRegenerations: [],
        monthlySummaryRegenerations: [],
    };

    if (!summary.branchUpdated && !args.fixAttendance) {
        return summary;
    }

    const datesToRegenerate = new Map<string, { employeeId: Types.ObjectId; date: string }>();

    if (args.fixAttendance) {
        const events = await AttendanceEvent.find({ branch: branchId }).sort({ timestamp: 1 }).lean();
        const previousSnapshotDates = await collectSnapshotDates(branchId);

        for (const event of events) {
            const local = branchLocalParts(event.timestamp, args.timezone);
            const update: EventLocalFieldUpdate = {
                eventId: String(event._id),
                employeeId: String(event.employee),
                previousBranchLocalDate: event.branchLocalDate,
                nextBranchLocalDate: local.date,
                previousBranchLocalTime: event.branchLocalTime,
                nextBranchLocalTime: local.time,
                previousBranchTimezone: event.branchTimezone,
            };

            const changed = update.previousBranchLocalDate !== update.nextBranchLocalDate
                || update.previousBranchLocalTime !== update.nextBranchLocalTime
                || update.previousBranchTimezone !== args.timezone;

            if (changed) {
                summary.eventUpdates.push(update);
            }

            if (args.apply && changed) {
                await AttendanceEvent.updateOne(
                    { _id: event._id },
                    {
                        $set: {
                            branchLocalDate: local.date,
                            branchLocalTime: local.time,
                            branchTimezone: args.timezone,
                        },
                    },
                );
            }

            const employeeId = event.employee as Types.ObjectId;
            datesToRegenerate.set(`${String(employeeId)}:${update.previousBranchLocalDate}`, {
                employeeId,
                date: update.previousBranchLocalDate,
            });
            datesToRegenerate.set(`${String(employeeId)}:${update.nextBranchLocalDate}`, {
                employeeId,
                date: update.nextBranchLocalDate,
            });
        }

        for (const item of previousSnapshotDates) {
            datesToRegenerate.set(`${String(item.employeeId)}:${item.date}`, item);
        }

        if (args.apply) {
            const eventDates = await collectEventDates(branchId);
            for (const item of eventDates) {
                datesToRegenerate.set(`${String(item.employeeId)}:${item.date}`, item);
            }
        }
    }

    summary.snapshotRegenerations = [...datesToRegenerate.values()].map((item) => ({
        employeeId: String(item.employeeId),
        date: item.date,
    }));

    const monthsToRegenerate = new Map<string, { employeeId: Types.ObjectId; month: string }>();
    for (const item of datesToRegenerate.values()) {
        monthsToRegenerate.set(`${String(item.employeeId)}:${monthFromDate(item.date)}`, {
            employeeId: item.employeeId,
            month: monthFromDate(item.date),
        });
    }
    summary.monthlySummaryRegenerations = [...monthsToRegenerate.values()].map((item) => ({
        employeeId: String(item.employeeId),
        month: item.month,
    }));

    if (args.apply) {
        if (summary.branchUpdated) {
            await Branch.updateOne(
                { _id: branchId },
                { $set: { timezone: args.timezone } },
            );
        }

        if (args.fixAttendance) {
            for (const item of datesToRegenerate.values()) {
                await regenerateAttendanceDailySnapshot({
                    employeeId: item.employeeId,
                    branchId,
                    dateString: item.date,
                });
            }

            for (const item of monthsToRegenerate.values()) {
                await regenerateMonthlySummary(item.employeeId, branchId, item.month, args.timezone);
            }
        }
    }

    return summary;
};

const run = async () => {
    const args = parseArgs();
    if (!args.branchId && !args.branchName) {
        usage();
        process.exit(1);
        return;
    }

    await connectDb();
    try {
        const result = await changeBranchTimezone(args);
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await mongoose.connection.close();
    }
};

if (require.main === module) {
    run().catch(async (error) => {
        console.error(error);
        try { await mongoose.connection.close(); } catch {}
        process.exit(1);
    });
}
