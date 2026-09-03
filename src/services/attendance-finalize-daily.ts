import { Types } from 'mongoose';
import Branch from '../models/Branch';
import User from '../models/User';
import AttendanceDailySnapshot from '../models/AttendanceDailySnapshot';
import {
    attendanceLocalDateString,
    generateAttendanceDailySnapshotForScheduledJob,
} from '../controllers/attendance/attendanceController';
import { logger } from '../logging/logger';

const PROBLEM_STATUSES = new Set(['missing_checkout', 'open_break', 'incomplete']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export type FinalizeBranchResult = {
    branchId: string;
    branchName: string;
    date: string;
    processed: number;
    createdOrUpdated: number;
    skipped: number;
    snapshots: any[];
    errors: Array<{ employeeId: string; message: string }>;
};

function assertDateString(value: string, fieldName: string): string {
    if (!datePattern.test(value)) {
        throw new Error(`${fieldName} must use YYYY-MM-DD format`);
    }
    return value;
}

export function addCalendarDays(dateString: string, days: number): string {
    assertDateString(dateString, 'date');
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export function yesterdayInTimezone(now: Date, timezone: string): string {
    const todayLocal = attendanceLocalDateString(now, timezone);
    return addCalendarDays(todayLocal, -1);
}

export function eachDateInclusive(from: string, to: string): string[] {
    assertDateString(from, 'from');
    assertDateString(to, 'to');
    if (from > to) {
        throw new Error('from must be on or before to');
    }
    const dates: string[] = [];
    let cursor = from;
    while (cursor <= to) {
        dates.push(cursor);
        cursor = addCalendarDays(cursor, 1);
    }
    return dates;
}

async function resolveActiveEmployeeIds(branch: {
    manager?: Types.ObjectId | null;
    staffs?: Types.ObjectId[];
}): Promise<Types.ObjectId[]> {
    const candidateIds = [
        ...(branch.manager ? [branch.manager] : []),
        ...(branch.staffs ?? []),
    ].map((id) => new Types.ObjectId(String(id)));

    if (candidateIds.length === 0) return [];

    const users = await User.find({
        _id: { $in: candidateIds },
        isActive: true,
        isAccountDeleted: { $ne: true },
    }).select('_id').lean();

    return users.map((user) => user._id as Types.ObjectId);
}

export async function finalizeBranchDailySnapshots(params: {
    branchId: Types.ObjectId | string;
    date: string;
}): Promise<FinalizeBranchResult> {
    const branchId = typeof params.branchId === 'string'
        ? Types.ObjectId.createFromHexString(params.branchId)
        : params.branchId;
    const date = assertDateString(params.date, 'date');
    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
        throw new Error('Branch not found');
    }

    const employeeIds = await resolveActiveEmployeeIds(branch);
    const result: FinalizeBranchResult = {
        branchId: String(branch._id),
        branchName: branch.name,
        date,
        processed: 0,
        createdOrUpdated: 0,
        skipped: 0,
        snapshots: [],
        errors: [],
    };

    for (const employeeId of employeeIds) {
        result.processed += 1;
        try {
            const existing = await AttendanceDailySnapshot.findOne({
                employee: employeeId,
                date,
            }).select('status').lean();
            if (existing && !PROBLEM_STATUSES.has(existing.status)) {
                result.skipped += 1;
                continue;
            }
            const snapshot = await generateAttendanceDailySnapshotForScheduledJob({
                employeeId,
                branchId: branch._id as Types.ObjectId,
                dateString: date,
            });
            result.createdOrUpdated += 1;
            result.snapshots.push(snapshot);
        } catch (error) {
            result.errors.push({
                employeeId: String(employeeId),
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return result;
}

export async function finalizeAllBranchesForLocalYesterday(
    now = new Date(),
): Promise<FinalizeBranchResult[]> {
    const branches = await Branch.find({
        isActive: true,
        attendanceEnabled: true,
    }).select('_id name timezone').lean();

    const results: FinalizeBranchResult[] = [];
    for (const branch of branches) {
        const timezone = branch.timezone || 'Asia/Kolkata';
        const date = yesterdayInTimezone(now, timezone);
        try {
            const result = await finalizeBranchDailySnapshots({
                branchId: branch._id as Types.ObjectId,
                date,
            });
            results.push(result);
            void logger.log('Attendance daily finalize completed for branch', {
                branchId: result.branchId,
                branchName: result.branchName,
                date: result.date,
                processed: result.processed,
                createdOrUpdated: result.createdOrUpdated,
                skipped: result.skipped,
                errorCount: result.errors.length,
            });
        } catch (error) {
            void logger.error('Attendance daily finalize failed for branch', {
                branchId: String(branch._id),
                branchName: branch.name,
                date,
                error: error instanceof Error ? error.message : String(error),
            });
            results.push({
                branchId: String(branch._id),
                branchName: branch.name,
                date,
                processed: 0,
                createdOrUpdated: 0,
                skipped: 0,
                snapshots: [],
                errors: [{
                    employeeId: '',
                    message: error instanceof Error ? error.message : String(error),
                }],
            });
        }
    }
    return results;
}

export async function finalizeAllBranchesForDateRange(params: {
    from: string;
    to: string;
}): Promise<FinalizeBranchResult[]> {
    const dates = eachDateInclusive(params.from, params.to);
    const branches = await Branch.find({
        isActive: true,
        attendanceEnabled: true,
    }).select('_id name').lean();

    const results: FinalizeBranchResult[] = [];
    for (const branch of branches) {
        for (const date of dates) {
            const result = await finalizeBranchDailySnapshots({
                branchId: branch._id as Types.ObjectId,
                date,
            });
            results.push(result);
        }
    }
    return results;
}
