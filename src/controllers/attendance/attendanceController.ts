import { Request, Response } from 'express';
import asyncHandler from 'express-async-handler';
import mongoose, { Types } from 'mongoose';
import { AppError, onCatchError } from '../../middleware/error';
import User from '../../models/User';
import Branch from '../../models/Branch';
import AttendanceShift, {
    AttendanceWeekday,
    IAttendanceShiftDayRule,
    IAttendanceShiftWeeklyPattern,
} from '../../models/AttendanceShift';
import AttendanceShiftMembership from '../../models/AttendanceShiftMembership';
import AttendanceShiftOverride from '../../models/AttendanceShiftOverride';
import AttendancePrivilege from '../../models/AttendancePrivilege';
import AttendanceBreakType, { AttendanceBreakSubtype } from '../../models/AttendanceBreak';
import AttendanceScheduleTemplate, { AttendanceScheduleAssignment } from '../../models/AttendanceSchedule';
import AttendanceEvent from '../../models/AttendanceEvent';
import AttendanceDailySnapshot from '../../models/AttendanceDailySnapshot';
import AttendanceMonthlySummary from '../../models/AttendanceMonthlySummary';

type GeneratedBy = 'checkout' | 'scheduled_job' | 'correction' | 'manual';
type Actor = Pick<Request, 'userId' | 'privilege'>;
type ResolvedShift = {
    _id: Types.ObjectId;
    version?: number;
    startTime: string;
    endTime: string;
    requiredWorkMinutes: number;
    graceLateMinutes?: number;
    graceEarlyLeaveMinutes?: number;
};
type ResolvedSchedule = {
    employeeId: string;
    branchId: string;
    branchTimezone: string;
    source: 'branch' | 'global' | 'shift_membership' | null;
    assignment: { _id: Types.ObjectId } | null;
    template: { _id: Types.ObjectId } | null;
    shiftMembership?: { _id: Types.ObjectId } | null;
    override?: { _id: Types.ObjectId; overrideType: 'hours' | 'off_day' } | null;
    shifts: ResolvedShift[];
    scheduledSegments: Array<{ shift: Types.ObjectId; scheduledStart: string; scheduledEnd: string; requiredWorkMinutes: number }>;
    scheduledStart?: string;
    scheduledEnd?: string;
    requiredWorkMinutes: number;
};

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const weekdays: AttendanceWeekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function requireUserId(req: Request) {
    if (!req.userId || !Types.ObjectId.isValid(req.userId)) {
        throw new AppError('Not authorized', 401);
    }
    return Types.ObjectId.createFromHexString(req.userId);
}

function toObjectId(value: unknown, fieldName: string) {
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value)) {
        throw new AppError(`${fieldName} must be a valid id`, 400);
    }
    return Types.ObjectId.createFromHexString(value);
}

function requireAdmin(req: Request) {
    if (req.privilege !== 'admin') {
        throw new AppError('Admin privilege required', 403);
    }
}

function requireAdminOrManager(req: Request) {
    if (!['admin', 'manager'].includes(req.privilege)) {
        throw new AppError('Admin or manager privilege required', 403);
    }
}

async function getAttendancePrivilegeIds(userId: Types.ObjectId) {
    const user = await User.findById(userId, { attendancePrivilegeIds: 1 }).lean();
    return (user?.attendancePrivilegeIds ?? []).map((id) => new Types.ObjectId(String(id)));
}

function assertTime(value: unknown, fieldName: string) {
    if (typeof value !== 'string' || !timePattern.test(value)) {
        throw new AppError(`${fieldName} must use HH:mm format`, 400);
    }
}

function assertDate(value: unknown, fieldName: string) {
    if (typeof value !== 'string' || !datePattern.test(value)) {
        throw new AppError(`${fieldName} must use YYYY-MM-DD format`, 400);
    }
}

function numberOrDefault(value: unknown, fallback: number) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new AppError('Number fields must be zero or greater', 400);
    }
    return parsed;
}

function parseDate(value: unknown, fieldName: string) {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        throw new AppError(`${fieldName} must be a valid date`, 400);
    }
    return date;
}

function normalizeDayRule(value: unknown, fieldName: string): IAttendanceShiftDayRule | null {
    if (value === null || value === undefined || value === false) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError(`${fieldName} must be a day rule or null`, 400);
    }
    const source = value as Record<string, unknown>;
    assertTime(source.startTime, `${fieldName}.startTime`);
    assertTime(source.endTime, `${fieldName}.endTime`);
    return {
        startTime: String(source.startTime),
        endTime: String(source.endTime),
        requiredWorkMinutes: numberOrDefault(source.requiredWorkMinutes, 0),
    };
}

function normalizeWeeklyPattern(body: Record<string, unknown>): IAttendanceShiftWeeklyPattern {
    if (body.weeklyPattern && typeof body.weeklyPattern === 'object' && !Array.isArray(body.weeklyPattern)) {
        const source = body.weeklyPattern as Record<string, unknown>;
        return weekdays.reduce((pattern, weekday) => {
            pattern[weekday] = normalizeDayRule(source[weekday], `weeklyPattern.${weekday}`);
            return pattern;
        }, {} as IAttendanceShiftWeeklyPattern);
    }

    assertTime(body.startTime, 'startTime');
    assertTime(body.endTime, 'endTime');
    const weekdayRule = {
        startTime: String(body.startTime),
        endTime: String(body.endTime),
        requiredWorkMinutes: numberOrDefault(body.requiredWorkMinutes, 0),
    };

    return {
        monday: weekdayRule,
        tuesday: weekdayRule,
        wednesday: weekdayRule,
        thursday: weekdayRule,
        friday: weekdayRule,
        saturday: null,
        sunday: null,
    };
}

function firstWorkingRule(pattern: IAttendanceShiftWeeklyPattern) {
    return weekdays.map((weekday) => pattern[weekday]).find((rule): rule is IAttendanceShiftDayRule => !!rule);
}

function branchLocalParts(date: Date, timezone: string) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
    };
}

function branchLocalWeekday(dateString: string, timezone: string) {
    const date = new Date(`${dateString}T12:00:00.000Z`);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'long',
    }).format(date).toLowerCase() as AttendanceWeekday;
}

function minutesBetween(start: Date, end: Date) {
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function timeToMinutes(time?: string) {
    if (!time) return undefined;
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
}

function timezoneOffsetMinutes(date: Date, timezone: string) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second)
    );
    return (asUtc - date.getTime()) / 60000;
}

function nextBranchLocalDayBoundaryUtc(timezone: string, from = new Date()) {
    const local = branchLocalParts(from, timezone);
    const [year, month, day] = local.date.split('-').map(Number);
    const approximate = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
    const offset = timezoneOffsetMinutes(approximate, timezone);
    return new Date(approximate.getTime() - offset * 60000);
}

function branchLocalDateTimeToUtc(dateString: string, time: string, timezone: string) {
    assertDate(dateString, 'date');
    assertTime(time, 'checkoutTime');
    const [year, month, day] = dateString.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const approximate = new Date(Date.UTC(year, month - 1, day, hour, minute));
    const offset = timezoneOffsetMinutes(approximate, timezone);
    return new Date(approximate.getTime() - offset * 60000);
}

async function getEmployeeBranch(employeeId: Types.ObjectId) {
    const branch = await Branch.findOne({
        isActive: true,
        staffs: employeeId,
    });

    if (!branch) {
        throw new AppError('Employee does not belong to an active attendance branch', 400);
    }

    return branch;
}

async function assertManagerCanViewEmployee(actor: Actor, employeeId: string) {
    if (actor.privilege === 'admin') return;
    if (actor.privilege === 'staff') {
        if (actor.userId !== employeeId) {
            throw new AppError('Not authorized to view this employee attendance', 403);
        }
        return;
    }

    const employee = await User.findById(employeeId, { manager: 1 }).lean();
    if (!employee || String(employee.manager) !== actor.userId) {
        throw new AppError('Not authorized to view this employee attendance', 403);
    }
}

function ruleFromShiftForWeekday(shift: any, weekday: AttendanceWeekday): IAttendanceShiftDayRule | null {
    const weeklyRule = shift.weeklyPattern?.[weekday] as IAttendanceShiftDayRule | null | undefined;
    if (weeklyRule) return weeklyRule;
    if (shift.startTime && shift.endTime) {
        return {
            startTime: shift.startTime,
            endTime: shift.endTime,
            requiredWorkMinutes: shift.requiredWorkMinutes ?? 0,
        };
    }
    return null;
}

async function resolveWorkingShiftSchedule(
    employeeId: Types.ObjectId,
    branch: { _id: Types.ObjectId; timezone: string },
    dateString: string
): Promise<ResolvedSchedule | null> {
    const dayStart = new Date(`${dateString}T00:00:00.000Z`);
    const dayEnd = new Date(`${dateString}T23:59:59.999Z`);
    const membership = await AttendanceShiftMembership.findOne({
        employee: employeeId,
        branch: branch._id,
        status: 'active',
        activeFrom: { $lte: dayEnd },
        $or: [
            { inactiveFrom: { $exists: false } },
            { inactiveFrom: null },
            { inactiveFrom: { $gt: dayStart } },
        ],
    }).sort({ activeFrom: -1 });

    if (!membership) return null;

    const shift = await AttendanceShift.findOne({ _id: membership.shift, isActive: true }).lean();
    if (!shift) return null;

    const employeeOverride = await AttendanceShiftOverride.findOne({
        targetType: 'employee',
        branch: branch._id,
        employee: employeeId,
        date: dateString,
        isActive: true,
    }).sort({ version: -1, createdAt: -1 }).lean();

    const shiftOverride = await AttendanceShiftOverride.findOne({
        targetType: 'shift',
        branch: branch._id,
        shift: shift._id,
        date: dateString,
        isActive: true,
    }).sort({ version: -1, createdAt: -1 }).lean();

    const override = employeeOverride ?? shiftOverride;
    let rule = ruleFromShiftForWeekday(shift, branchLocalWeekday(dateString, branch.timezone));

    if (override?.overrideType === 'off_day') {
        rule = null;
    } else if (override?.overrideType === 'hours') {
        rule = {
            startTime: override.startTime!,
            endTime: override.endTime!,
            requiredWorkMinutes: override.requiredWorkMinutes,
        };
    }

    const resolvedShift: ResolvedShift | null = rule
        ? {
            _id: shift._id,
            version: shift.version,
            startTime: rule.startTime,
            endTime: rule.endTime,
            requiredWorkMinutes: rule.requiredWorkMinutes,
            graceLateMinutes: shift.graceLateMinutes,
            graceEarlyLeaveMinutes: shift.graceEarlyLeaveMinutes,
        }
        : null;

    const scheduledSegments = resolvedShift
        ? [{
            shift: resolvedShift._id,
            scheduledStart: resolvedShift.startTime,
            scheduledEnd: resolvedShift.endTime,
            requiredWorkMinutes: resolvedShift.requiredWorkMinutes,
        }]
        : [];

    return {
        employeeId: String(employeeId),
        branchId: String(branch._id),
        branchTimezone: branch.timezone,
        source: 'shift_membership',
        assignment: null,
        template: null,
        shiftMembership: { _id: membership._id },
        override: override ? { _id: override._id, overrideType: override.overrideType } : null,
        shifts: resolvedShift ? [resolvedShift] : [],
        scheduledSegments,
        scheduledStart: scheduledSegments[0]?.scheduledStart,
        scheduledEnd: scheduledSegments[scheduledSegments.length - 1]?.scheduledEnd,
        requiredWorkMinutes: scheduledSegments.reduce((sum, segment) => sum + segment.requiredWorkMinutes, 0),
    };
}

async function resolveSchedule(employeeId: Types.ObjectId, branchId: Types.ObjectId, dateString: string): Promise<ResolvedSchedule> {
    assertDate(dateString, 'date');
    const branch = await Branch.findById(branchId).lean();
    if (!branch) throw new AppError('Branch not found', 404);

    const workingShiftSchedule = await resolveWorkingShiftSchedule(employeeId, branch, dateString);
    if (workingShiftSchedule) return workingShiftSchedule;

    const dayStart = new Date(`${dateString}T00:00:00.000Z`);
    const dayEnd = new Date(`${dateString}T23:59:59.999Z`);
    const assignmentQuery = {
        isActive: true,
        supersededAt: { $exists: false },
        effectiveFrom: { $lte: dayEnd },
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: dayStart } }],
    };

    let source: 'branch' | 'global' = 'branch';
    let assignment = await AttendanceScheduleAssignment.findOne({
        ...assignmentQuery,
        targetType: 'branch',
        branch: branchId,
    }).sort({ effectiveFrom: -1 });

    if (!assignment) {
        source = 'global';
        assignment = await AttendanceScheduleAssignment.findOne({
            ...assignmentQuery,
            targetType: 'global',
        }).sort({ effectiveFrom: -1 });
    }

    if (!assignment) {
        return {
            employeeId: String(employeeId),
            branchId: String(branchId),
            branchTimezone: branch.timezone,
            source: null,
            assignment: null,
            template: null,
            shiftMembership: null,
            override: null,
            shifts: [] as ResolvedShift[],
            scheduledSegments: [] as Array<{ shift: Types.ObjectId; scheduledStart: string; scheduledEnd: string; requiredWorkMinutes: number }>,
            scheduledStart: undefined as string | undefined,
            scheduledEnd: undefined as string | undefined,
            requiredWorkMinutes: 0,
        };
    }

    const template = await AttendanceScheduleTemplate.findById(assignment.template).lean();
    if (!template) throw new AppError('Schedule template not found', 404);

    const weekday = branchLocalWeekday(dateString, branch.timezone);
    const shiftIds = ((template.weeklyPattern as any)?.[weekday] ?? []) as Types.ObjectId[];
    const shifts = await AttendanceShift.find({ _id: { $in: shiftIds }, isActive: true }).lean();
    const byId = new Map(shifts.map((shift) => [String(shift._id), shift]));
    const orderedShifts = shiftIds.map((id) => byId.get(String(id))).filter(Boolean) as ResolvedShift[];
    const scheduledSegments = orderedShifts.map((shift) => ({
        shift: shift._id,
        scheduledStart: shift.startTime,
        scheduledEnd: shift.endTime,
        requiredWorkMinutes: shift.requiredWorkMinutes,
    }));

    return {
        employeeId: String(employeeId),
        branchId: String(branchId),
        branchTimezone: branch.timezone,
        source,
        assignment,
        template,
        shiftMembership: null,
        override: null,
        shifts: orderedShifts,
        scheduledSegments,
        scheduledStart: scheduledSegments[0]?.scheduledStart,
        scheduledEnd: scheduledSegments[scheduledSegments.length - 1]?.scheduledEnd,
        requiredWorkMinutes: scheduledSegments.reduce((sum, segment) => sum + segment.requiredWorkMinutes, 0),
    };
}

async function getDayEvents(employeeId: Types.ObjectId, dateString: string) {
    return AttendanceEvent.find({
        employee: employeeId,
        branchLocalDate: dateString,
    }).sort({ timestamp: 1 });
}

async function generateDailySnapshot(params: {
    employeeId: Types.ObjectId;
    branchId: Types.ObjectId;
    dateString: string;
    generatedBy: GeneratedBy;
    notes?: string;
}) {
    const schedule = await resolveSchedule(params.employeeId, params.branchId, params.dateString);
    const events = await getDayEvents(params.employeeId, params.dateString);
    const firstCheckIn = events.find((event) => event.type === 'check_in');
    const checkOuts = events.filter((event) => event.type === 'check_out');
    const lastCheckOut = checkOuts[checkOuts.length - 1];

    let status: 'present' | 'absent' | 'off_day' | 'incomplete' | 'missing_checkout' | 'open_break';
    let grossMinutes = 0;
    let totalBreakMinutes = 0;
    let productiveWorkMinutes = 0;
    let breakOvertimeMinutes = 0;
    let breakUndertimeMinutes = 0;
    const breakTotals: Array<Record<string, unknown>> = [];

    const openBreakStack: typeof events = [];
    const breakPairs: Array<{ start: typeof events[number]; end: typeof events[number] }> = [];
    for (const event of events) {
        if (event.type === 'break_start') {
            openBreakStack.push(event);
        } else if (event.type === 'break_end') {
            const start = openBreakStack.shift();
            if (start) breakPairs.push({ start, end: event });
        }
    }

    if (!firstCheckIn && schedule.requiredWorkMinutes === 0) {
        status = 'off_day';
    } else if (!firstCheckIn) {
        status = 'absent';
    } else if (openBreakStack.length > 0) {
        status = 'open_break';
    } else if (!lastCheckOut) {
        status = 'missing_checkout';
    } else {
        status = 'present';
    }

    const dailyBreakUsage = new Map<string, number>();
    for (const pair of breakPairs) {
        const actualMinutes = minutesBetween(pair.start.timestamp, pair.end.timestamp);
        totalBreakMinutes += actualMinutes;

        const breakType = pair.start.breakType
            ? await AttendanceBreakType.findById(pair.start.breakType).lean()
            : null;
        const breakSubtype = pair.start.breakSubtype
            ? await AttendanceBreakSubtype.findById(pair.start.breakSubtype).lean()
            : null;
        const dailyKey = String(pair.start.breakType ?? 'unknown');
        const dailyUsed = dailyBreakUsage.get(dailyKey) ?? 0;
        const dailyLimit = breakType?.maxMinutesPerDay ?? Number.POSITIVE_INFINITY;
        const perEventLimit = breakSubtype?.maxMinutesPerEvent ?? Number.POSITIVE_INFINITY;
        const remainingDaily = Math.max(0, dailyLimit - dailyUsed);
        const allowedBudget = Math.min(perEventLimit, remainingDaily);
        const normalizedAllowedBudget = Number.isFinite(allowedBudget) ? allowedBudget : actualMinutes;
        const allowedMinutes = Math.min(actualMinutes, normalizedAllowedBudget);
        const excessMinutes = Math.max(0, actualMinutes - normalizedAllowedBudget);
        const unusedAllowedMinutes = Math.max(0, normalizedAllowedBudget - actualMinutes);

        dailyBreakUsage.set(dailyKey, dailyUsed + allowedMinutes);
        breakOvertimeMinutes += unusedAllowedMinutes;
        breakUndertimeMinutes += excessMinutes;
        breakTotals.push({
            breakType: pair.start.breakType,
            breakSubtype: pair.start.breakSubtype,
            minutes: actualMinutes,
            allowedMinutes,
            excessMinutes,
            unusedAllowedMinutes,
            overtimeMinutes: unusedAllowedMinutes,
            undertimeMinutes: excessMinutes,
        });
    }

    if (firstCheckIn && lastCheckOut) {
        grossMinutes = minutesBetween(firstCheckIn.timestamp, lastCheckOut.timestamp);
        productiveWorkMinutes = Math.max(0, grossMinutes - totalBreakMinutes);
    }

    const overtimeMinutes = Math.max(0, productiveWorkMinutes - schedule.requiredWorkMinutes);
    const undertimeMinutes = Math.max(0, schedule.requiredWorkMinutes - productiveWorkMinutes);
    const firstLocal = firstCheckIn ? branchLocalParts(firstCheckIn.timestamp, schedule.branchTimezone) : undefined;
    const lastLocal = lastCheckOut ? branchLocalParts(lastCheckOut.timestamp, schedule.branchTimezone) : undefined;
    const firstMinutes = timeToMinutes(firstLocal?.time);
    const lastMinutes = timeToMinutes(lastLocal?.time);
    const scheduledStartMinutes = timeToMinutes(schedule.scheduledStart);
    const scheduledEndMinutes = timeToMinutes(schedule.scheduledEnd);
    const firstShift = schedule.shifts[0];
    const lastShift = schedule.shifts[schedule.shifts.length - 1];
    const lateMinutes =
        firstMinutes !== undefined && scheduledStartMinutes !== undefined
            ? Math.max(0, firstMinutes - scheduledStartMinutes - (firstShift?.graceLateMinutes ?? 0))
            : 0;
    const earlyLeaveMinutes =
        lastMinutes !== undefined && scheduledEndMinutes !== undefined
            ? Math.max(0, scheduledEndMinutes - lastMinutes - (lastShift?.graceEarlyLeaveMinutes ?? 0))
            : 0;

    const existing = await AttendanceDailySnapshot.findOne({
        employee: params.employeeId,
        date: params.dateString,
    });

    const payload = {
        employee: params.employeeId,
        branch: params.branchId,
        date: params.dateString,
        branchTimezone: schedule.branchTimezone,
        scheduleAssignment: schedule.assignment?._id,
        scheduleTemplate: schedule.template?._id,
        shiftIds: schedule.shifts.map((shift) => shift._id),
        scheduledSegments: schedule.scheduledSegments,
        scheduledStart: schedule.scheduledStart,
        scheduledEnd: schedule.scheduledEnd,
        requiredWorkMinutes: schedule.requiredWorkMinutes,
        firstCheckIn: firstLocal?.time,
        lastCheckOut: lastLocal?.time,
        firstCheckInAt: firstCheckIn?.timestamp,
        lastCheckOutAt: lastCheckOut?.timestamp,
        grossMinutes,
        productiveWorkMinutes,
        totalBreakMinutes,
        breakOvertimeMinutes,
        breakUndertimeMinutes,
        overtimeMinutes,
        undertimeMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        breakTotals,
        status,
        generatedFromEventIds: events.map((event) => event._id),
        generatedBy: params.generatedBy,
        generatedAt: new Date(),
        version: existing ? existing.version + 1 : 1,
        notes: params.notes,
    };

    return AttendanceDailySnapshot.findOneAndUpdate(
        { employee: params.employeeId, date: params.dateString },
        { $set: payload },
        { new: true, upsert: true }
    );
}

function ok(handler: (req: Request, res: Response) => Promise<void>) {
    return asyncHandler(async (req: Request, res: Response) => {
        try {
            await handler(req, res);
        } catch (e) {
            onCatchError(e, res);
        }
    });
}

export const createShift = ok(async (req, res) => {
    requireAdmin(req);
    const createdBy = requireUserId(req);
    const weeklyPattern = normalizeWeeklyPattern(req.body);
    const firstRule = firstWorkingRule(weeklyPattern);
    if (!firstRule) throw new AppError('At least one working day is required', 400);
    const shift = await AttendanceShift.create({
        name: req.body.name,
        startTime: req.body.startTime ?? firstRule.startTime,
        endTime: req.body.endTime ?? firstRule.endTime,
        requiredWorkMinutes: req.body.requiredWorkMinutes ?? firstRule.requiredWorkMinutes,
        weeklyPattern,
        version: 1,
        graceLateMinutes: numberOrDefault(req.body.graceLateMinutes, 0),
        graceEarlyLeaveMinutes: numberOrDefault(req.body.graceEarlyLeaveMinutes, 0),
        isActive: req.body.isActive ?? true,
        createdBy,
    });
    res.status(201).json(shift);
});

export const listShifts = ok(async (req, res) => {
    requireAdminOrManager(req);
    const shifts = await AttendanceShift.find().sort({ createdAt: -1 });
    res.status(200).json({ items: shifts });
});

export const updateShift = ok(async (req, res) => {
    requireAdmin(req);
    const existing = await AttendanceShift.findById(req.params.id);
    if (!existing) throw new AppError('Shift not found', 404);

    const update: Record<string, unknown> = { ...req.body };
    if (req.body.weeklyPattern || req.body.startTime || req.body.endTime || req.body.requiredWorkMinutes !== undefined) {
        const bodyForPattern = {
            startTime: req.body.startTime ?? existing.startTime,
            endTime: req.body.endTime ?? existing.endTime,
            requiredWorkMinutes: req.body.requiredWorkMinutes ?? existing.requiredWorkMinutes,
            weeklyPattern: req.body.weeklyPattern ?? existing.weeklyPattern,
        };
        const weeklyPattern = normalizeWeeklyPattern(bodyForPattern);
        const firstRule = firstWorkingRule(weeklyPattern);
        if (!firstRule) throw new AppError('At least one working day is required', 400);
        update.weeklyPattern = weeklyPattern;
        update.startTime = req.body.startTime ?? firstRule.startTime;
        update.endTime = req.body.endTime ?? firstRule.endTime;
        update.requiredWorkMinutes = req.body.requiredWorkMinutes ?? firstRule.requiredWorkMinutes;
    }
    if (update.graceLateMinutes !== undefined) update.graceLateMinutes = numberOrDefault(update.graceLateMinutes, 0);
    if (update.graceEarlyLeaveMinutes !== undefined) update.graceEarlyLeaveMinutes = numberOrDefault(update.graceEarlyLeaveMinutes, 0);

    existing.previousVersions.push({
        version: existing.version,
        name: existing.name,
        startTime: existing.startTime,
        endTime: existing.endTime,
        requiredWorkMinutes: existing.requiredWorkMinutes,
        weeklyPattern: existing.weeklyPattern,
        graceLateMinutes: existing.graceLateMinutes,
        graceEarlyLeaveMinutes: existing.graceEarlyLeaveMinutes,
        isActive: existing.isActive,
        savedAt: new Date(),
    });
    existing.set({ ...update, version: existing.version + 1 });
    const shift = await existing.save();
    if (!shift) throw new AppError('Shift not found', 404);
    res.status(200).json(shift);
});

async function getBranchForAssignment(branchId: Types.ObjectId) {
    const branch = await Branch.findById(branchId);
    if (!branch || !branch.isActive) throw new AppError('Branch not found or inactive', 404);
    return branch;
}

function branchContainsEmployee(branch: { staffs?: Types.ObjectId[] }, employeeId: Types.ObjectId) {
    return (branch.staffs ?? []).some((staffId) => String(staffId) === String(employeeId));
}

export const assignShiftMembers = ok(async (req, res) => {
    requireAdmin(req);
    const createdBy = requireUserId(req);
    const shift = await AttendanceShift.findById(toObjectId(req.body.shiftId, 'shiftId')).lean();
    if (!shift || !shift.isActive) throw new AppError('Shift not found or inactive', 404);

    const branch = await getBranchForAssignment(toObjectId(req.body.branchId, 'branchId'));
    const employeeIds = req.body.allStaff === true
        ? (branch.staffs ?? []).map((id) => new Types.ObjectId(String(id)))
        : Array.isArray(req.body.employeeIds)
            ? req.body.employeeIds.map((id: string) => toObjectId(id, 'employeeIds'))
            : [];

    if (employeeIds.length === 0) throw new AppError('At least one employee is required', 400);
    const uniqueEmployeeIds = (Array.from(new Set(employeeIds.map(String))) as string[])
        .map((id) => Types.ObjectId.createFromHexString(id));
    for (const employeeId of uniqueEmployeeIds) {
        if (!branchContainsEmployee(branch, employeeId)) {
            throw new AppError('Employees must belong to the selected branch', 400);
        }
    }

    const activeFrom = nextBranchLocalDayBoundaryUtc(branch.timezone);
    const existing = await AttendanceShiftMembership.find({
        employee: { $in: uniqueEmployeeIds },
        branch: branch._id,
        status: 'active',
        $or: [{ inactiveFrom: { $exists: false } }, { inactiveFrom: null }, { inactiveFrom: { $gt: activeFrom } }],
    });

    const conflicts = existing.filter((item) => String(item.shift) !== String(shift._id));
    if (conflicts.length > 0 && req.body.replaceExisting !== true) {
        res.status(409).json({
            message: 'One or more employees already have active shift coverage',
            conflicts: conflicts.map((item) => ({
                employeeId: String(item.employee),
                shiftId: String(item.shift),
                membershipId: String(item._id),
            })),
        });
        return;
    }

    if (req.body.replaceExisting === true && existing.length > 0) {
        await AttendanceShiftMembership.updateMany(
            { _id: { $in: existing.map((item) => item._id) } },
            {
                $set: {
                    status: 'inactive',
                    inactiveFrom: activeFrom,
                    endedBy: createdBy,
                },
            }
        );
    }

    const existingSameShift = req.body.replaceExisting === true
        ? new Set<string>()
        : new Set(
            existing
                .filter((item) => String(item.shift) === String(shift._id) && item.status === 'active')
                .map((item) => String(item.employee))
        );
    const docs = uniqueEmployeeIds
        .filter((employeeId) => !existingSameShift.has(String(employeeId)))
        .map((employeeId) => ({
            shift: shift._id,
            employee: employeeId,
            branch: branch._id,
            version: 1,
            status: 'active',
            activeFrom,
            createdBy,
        }));
    const memberships = docs.length > 0 ? await AttendanceShiftMembership.insertMany(docs) : [];
    res.status(201).json({ items: memberships, activeFrom });
});

export const listShiftMemberships = ok(async (req, res) => {
    requireAdmin(req);
    const query: Record<string, unknown> = {};
    if (req.query.shiftId) query.shift = toObjectId(req.query.shiftId, 'shiftId');
    if (req.query.branchId) query.branch = toObjectId(req.query.branchId, 'branchId');
    if (req.query.employeeId) query.employee = toObjectId(req.query.employeeId, 'employeeId');
    if (req.query.status) query.status = String(req.query.status);
    const items = await AttendanceShiftMembership.find(query)
        .populate('shift', 'name version isActive')
        .populate('employee', 'username privilege isActive')
        .populate('branch', 'name timezone isActive')
        .sort({ createdAt: -1 });
    res.status(200).json({ items });
});

export const removeShiftMembership = ok(async (req, res) => {
    requireAdmin(req);
    const membership = await AttendanceShiftMembership.findById(req.params.id);
    if (!membership) throw new AppError('Shift membership not found', 404);
    const branch = await Branch.findById(membership.branch).lean();
    if (!branch) throw new AppError('Branch not found', 404);
    membership.status = 'inactive';
    membership.inactiveFrom = nextBranchLocalDayBoundaryUtc(branch.timezone);
    membership.endedBy = requireUserId(req);
    await membership.save();
    res.status(200).json(membership);
});

export const createShiftOverride = ok(async (req, res) => {
    requireAdmin(req);
    const createdBy = requireUserId(req);
    const branch = await getBranchForAssignment(toObjectId(req.body.branchId, 'branchId'));
    assertDate(req.body.date, 'date');
    if (!['shift', 'employee'].includes(req.body.targetType)) {
        throw new AppError('targetType must be shift or employee', 400);
    }
    if (!['hours', 'off_day'].includes(req.body.overrideType)) {
        throw new AppError('overrideType must be hours or off_day', 400);
    }

    const targetType = req.body.targetType as 'shift' | 'employee';
    const overrideType = req.body.overrideType as 'hours' | 'off_day';
    const shift = targetType === 'shift' ? toObjectId(req.body.shiftId, 'shiftId') : undefined;
    const employee = targetType === 'employee' ? toObjectId(req.body.employeeId, 'employeeId') : undefined;
    if (employee && !branchContainsEmployee(branch, employee)) {
        throw new AppError('Employee must belong to the selected branch', 400);
    }
    if (overrideType === 'hours') {
        assertTime(req.body.startTime, 'startTime');
        assertTime(req.body.endTime, 'endTime');
    }

    const conflictFilter = targetType === 'shift'
        ? { targetType, branch: branch._id, shift, date: req.body.date, isActive: true }
        : { targetType, branch: branch._id, employee, date: req.body.date, isActive: true };
    const existing = await AttendanceShiftOverride.find(conflictFilter).sort({ version: -1 });
    if (existing.length > 0 && req.body.replaceExisting !== true) {
        res.status(409).json({
            message: 'An active override already exists for this target and date',
            conflicts: existing.map((item) => String(item._id)),
        });
        return;
    }
    if (existing.length > 0) {
        await AttendanceShiftOverride.updateMany(
            { _id: { $in: existing.map((item) => item._id) } },
            { $set: { isActive: false, supersededAt: new Date() } }
        );
    }

    const override = await AttendanceShiftOverride.create({
        targetType,
        branch: branch._id,
        shift,
        employee,
        date: req.body.date,
        overrideType,
        startTime: overrideType === 'hours' ? req.body.startTime : undefined,
        endTime: overrideType === 'hours' ? req.body.endTime : undefined,
        requiredWorkMinutes: overrideType === 'hours' ? numberOrDefault(req.body.requiredWorkMinutes, 0) : 0,
        note: req.body.note,
        version: existing[0] ? existing[0].version + 1 : 1,
        isActive: true,
        createdBy,
    });
    res.status(201).json(override);
});

export const listShiftOverrides = ok(async (req, res) => {
    requireAdmin(req);
    const query: Record<string, unknown> = {};
    if (req.query.branchId) query.branch = toObjectId(req.query.branchId, 'branchId');
    if (req.query.shiftId) query.shift = toObjectId(req.query.shiftId, 'shiftId');
    if (req.query.employeeId) query.employee = toObjectId(req.query.employeeId, 'employeeId');
    if (req.query.date) {
        assertDate(req.query.date, 'date');
        query.date = String(req.query.date);
    }
    if (req.query.isActive !== undefined) query.isActive = String(req.query.isActive) !== 'false';
    const items = await AttendanceShiftOverride.find(query)
        .populate('shift', 'name version isActive')
        .populate('employee', 'username privilege isActive')
        .populate('branch', 'name timezone isActive')
        .sort({ date: -1, createdAt: -1 });
    res.status(200).json({ items });
});

export const updateShiftOverride = ok(async (req, res) => {
    requireAdmin(req);
    const update: Record<string, unknown> = { ...req.body };
    if (update.date) assertDate(update.date, 'date');
    if (update.startTime) assertTime(update.startTime, 'startTime');
    if (update.endTime) assertTime(update.endTime, 'endTime');
    if (update.requiredWorkMinutes !== undefined) update.requiredWorkMinutes = numberOrDefault(update.requiredWorkMinutes, 0);
    const override = await AttendanceShiftOverride.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!override) throw new AppError('Shift override not found', 404);
    res.status(200).json(override);
});

export const createPrivilege = ok(async (req, res) => {
    requireAdmin(req);
    const privilege = await AttendancePrivilege.create({
        name: req.body.name,
        description: req.body.description,
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(privilege);
});

export const listPrivileges = ok(async (req, res) => {
    requireAdmin(req);
    const items = await AttendancePrivilege.find().sort({ name: 1 });
    res.status(200).json({ items });
});

export const updatePrivilege = ok(async (req, res) => {
    requireAdmin(req);
    const privilege = await AttendancePrivilege.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!privilege) throw new AppError('Privilege not found', 404);
    res.status(200).json(privilege);
});

export const setEmployeePrivileges = ok(async (req, res) => {
    requireAdmin(req);
    const employeeId = toObjectId(req.params.employeeId, 'employeeId');
    const privilegeIds = Array.isArray(req.body.privilegeIds)
        ? req.body.privilegeIds.map((id: string) => toObjectId(id, 'privilegeIds'))
        : [];
    const user = await User.findByIdAndUpdate(
        employeeId,
        { attendancePrivilegeIds: privilegeIds },
        { new: true, runValidators: true }
    ).select('_id username attendancePrivilegeIds');
    if (!user) throw new AppError('Employee not found', 404);
    res.status(200).json({ employeeId: String(user._id), privilegeIds: user.attendancePrivilegeIds.map(String) });
});

export const getEmployeePrivileges = ok(async (req, res) => {
    requireAdmin(req);
    const user = await User.findById(req.params.employeeId)
        .select('_id username attendancePrivilegeIds')
        .populate('attendancePrivilegeIds', 'name description isActive');
    if (!user) throw new AppError('Employee not found', 404);
    res.status(200).json(user);
});

export const createBreakType = ok(async (req, res) => {
    requireAdmin(req);
    const privilegeIds = Array.isArray(req.body.privilegeIds)
        ? req.body.privilegeIds.map((id: string) => toObjectId(id, 'privilegeIds'))
        : [];
    const breakType = await AttendanceBreakType.create({
        name: req.body.name,
        privilegeIds,
        maxMinutesPerDay: req.body.maxMinutesPerDay,
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(breakType);
});

export const listBreakTypes = ok(async (req, res) => {
    const employeeId = requireUserId(req);
    const query: Record<string, unknown> = {};
    if (req.privilege === 'staff') {
        const privilegeIds = await getAttendancePrivilegeIds(employeeId);
        query.isActive = true;
        query.$or = [
            { privilegeIds: { $size: 0 } },
            { privilegeIds: { $in: privilegeIds } },
        ];
    } else {
        requireAdminOrManager(req);
    }
    const items = await AttendanceBreakType.find(query).sort({ name: 1 });
    res.status(200).json({ items });
});

export const updateBreakType = ok(async (req, res) => {
    requireAdmin(req);
    const breakType = await AttendanceBreakType.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!breakType) throw new AppError('Break type not found', 404);
    res.status(200).json(breakType);
});

export const createBreakSubtype = ok(async (req, res) => {
    requireAdmin(req);
    const parentBreak = await AttendanceBreakType.findById(req.params.id).lean();
    if (!parentBreak) throw new AppError('Break type not found', 404);
    if (req.body.windowStart) assertTime(req.body.windowStart, 'windowStart');
    if (req.body.windowEnd) assertTime(req.body.windowEnd, 'windowEnd');
    const parentHasPrivileges = (parentBreak.privilegeIds ?? []).length > 0;
    const privilegeIds = parentHasPrivileges
        ? []
        : Array.isArray(req.body.privilegeIds)
            ? req.body.privilegeIds.map((id: string) => toObjectId(id, 'privilegeIds'))
            : [];
    const subtype = await AttendanceBreakSubtype.create({
        parentBreak: parentBreak._id,
        name: req.body.name,
        privilegeIds,
        inheritsParentPrivilege: parentHasPrivileges ? true : req.body.inheritsParentPrivilege ?? false,
        windowStart: req.body.windowStart,
        windowEnd: req.body.windowEnd,
        maxMinutesPerEvent: req.body.maxMinutesPerEvent,
        maxEventsPerDay: req.body.maxEventsPerDay,
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(subtype);
});

export const updateBreakSubtype = ok(async (req, res) => {
    requireAdmin(req);
    if (req.body.windowStart) assertTime(req.body.windowStart, 'windowStart');
    if (req.body.windowEnd) assertTime(req.body.windowEnd, 'windowEnd');
    const subtype = await AttendanceBreakSubtype.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!subtype) throw new AppError('Break subtype not found', 404);
    res.status(200).json(subtype);
});

export const listBreakSubtypes = ok(async (req, res) => {
    const employeeId = requireUserId(req);
    const query: Record<string, unknown> = { parentBreak: req.params.id };
    if (req.privilege === 'staff') {
        const parentBreak = await AttendanceBreakType.findById(req.params.id).lean();
        if (!parentBreak || !parentBreak.isActive) throw new AppError('Break type not found', 404);
        const privilegeIds = await getAttendancePrivilegeIds(employeeId);
        const parentPrivilegeIds = parentBreak.privilegeIds ?? [];
        const parentRestricted = parentPrivilegeIds.length > 0;
        const parentAllowed = !parentRestricted || parentPrivilegeIds.some((id) =>
            privilegeIds.some((privilegeId) => String(privilegeId) === String(id))
        );
        if (!parentAllowed) throw new AppError('Employee is not eligible for this break', 403);
        query.isActive = true;
        if (!parentRestricted) {
            query.$or = [
                { privilegeIds: { $size: 0 } },
                { privilegeIds: { $in: privilegeIds } },
            ];
        }
    } else {
        requireAdminOrManager(req);
    }
    const items = await AttendanceBreakSubtype.find(query).sort({ name: 1 });
    res.status(200).json({ items });
});

export const createScheduleTemplate = ok(async (req, res) => {
    requireAdmin(req);
    const template = await AttendanceScheduleTemplate.create({
        name: req.body.name,
        type: 'weekly',
        weeklyPattern: req.body.weeklyPattern,
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(template);
});

export const listScheduleTemplates = ok(async (req, res) => {
    requireAdminOrManager(req);
    const items = await AttendanceScheduleTemplate.find().sort({ name: 1 });
    res.status(200).json({ items });
});

export const updateScheduleTemplate = ok(async (req, res) => {
    requireAdmin(req);
    const template = await AttendanceScheduleTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!template) throw new AppError('Schedule template not found', 404);
    res.status(200).json(template);
});

export const createScheduleAssignment = ok(async (req, res) => {
    requireAdmin(req);
    if (!['global', 'branch'].includes(req.body.targetType)) {
        throw new AppError('targetType must be global or branch', 400);
    }
    const template = toObjectId(req.body.templateId, 'templateId');
    const branch = req.body.targetType === 'branch' ? toObjectId(req.body.branchId, 'branchId') : undefined;
    const effectiveFrom = parseDate(req.body.effectiveFrom, 'effectiveFrom');
    if (!effectiveFrom) throw new AppError('effectiveFrom is required', 400);
    const filter = req.body.targetType === 'branch'
        ? { targetType: 'branch', branch, isActive: true, supersededAt: { $exists: false } }
        : { targetType: 'global', isActive: true, supersededAt: { $exists: false } };
    await AttendanceScheduleAssignment.updateMany(filter, { $set: { supersededAt: new Date(), isActive: false } });
    const assignment = await AttendanceScheduleAssignment.create({
        template,
        targetType: req.body.targetType,
        branch,
        effectiveFrom,
        expiresAt: parseDate(req.body.expiresAt, 'expiresAt'),
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json({
        ...assignment.toObject(),
        templateId: String(assignment.template),
        branchId: assignment.branch ? String(assignment.branch) : undefined,
    });
});

export const listScheduleAssignments = ok(async (req, res) => {
    requireAdmin(req);
    const items = await AttendanceScheduleAssignment.find().sort({ createdAt: -1 });
    res.status(200).json({ items });
});

export const getEmployeeSchedule = ok(async (req, res) => {
    requireAdminOrManager(req);
    await assertManagerCanViewEmployee(req, req.params.employeeId);
    const employeeId = toObjectId(req.params.employeeId, 'employeeId');
    const branch = await getEmployeeBranch(employeeId);
    const date = String(req.query.date ?? branchLocalParts(new Date(), branch.timezone).date);
    const schedule = await resolveSchedule(employeeId, branch._id, date);
    res.status(200).json({
        employeeId: schedule.employeeId,
        branchId: schedule.branchId,
        branchTimezone: schedule.branchTimezone,
        source: schedule.source,
        assignmentId: schedule.assignment?._id,
        templateId: schedule.template?._id,
        shiftMembershipId: schedule.shiftMembership?._id,
        overrideId: schedule.override?._id,
        overrideType: schedule.override?.overrideType,
        scheduledStart: schedule.scheduledStart,
        scheduledEnd: schedule.scheduledEnd,
        requiredWorkMinutes: schedule.requiredWorkMinutes,
        scheduledSegments: schedule.scheduledSegments,
    });
});

async function createAttendanceEvent(req: Request, type: 'check_in' | 'check_out' | 'break_start' | 'break_end') {
    const employeeId = requireUserId(req);
    const branch = await getEmployeeBranch(employeeId);
    const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
    if (Number.isNaN(timestamp.getTime())) throw new AppError('timestamp must be valid', 400);
    const local = branchLocalParts(timestamp, branch.timezone);
    const existingEvents = await getDayEvents(employeeId, local.date);
    const hasCheckIn = existingEvents.some((event) => event.type === 'check_in');
    const hasCheckout = existingEvents.some((event) => event.type === 'check_out');
    const openBreak = existingEvents.reduce((open, event) => {
        if (event.type === 'break_start') return open + 1;
        if (event.type === 'break_end') return Math.max(0, open - 1);
        return open;
    }, 0);

    if (type === 'check_in' && hasCheckIn && !hasCheckout) {
        throw new AppError('Employee is already checked in', 409);
    }
    if (type !== 'check_in' && !hasCheckIn) {
        throw new AppError('Employee must check in first', 409);
    }
    if (hasCheckout && type !== 'check_in') {
        throw new AppError('Attendance day is already checked out', 409);
    }
    if (type === 'break_start' && openBreak > 0) {
        throw new AppError('A break is already open', 409);
    }
    if (type === 'break_end' && openBreak === 0) {
        throw new AppError('No open break to end', 409);
    }
    if (type === 'check_out' && openBreak > 0) {
        throw new AppError('End the open break before checkout', 409);
    }

    let breakType: Types.ObjectId | undefined;
    let breakSubtype: Types.ObjectId | undefined;
    if (type === 'break_start') {
        breakType = toObjectId(req.body.breakTypeId, 'breakTypeId');
        breakSubtype = req.body.breakSubtypeId ? toObjectId(req.body.breakSubtypeId, 'breakSubtypeId') : undefined;
        const breakDoc = await AttendanceBreakType.findById(breakType).lean();
        if (!breakDoc || !breakDoc.isActive) throw new AppError('Break type not found or inactive', 400);
        const subtype = breakSubtype ? await AttendanceBreakSubtype.findById(breakSubtype).lean() : null;
        if (breakSubtype && (!subtype || String(subtype.parentBreak) !== String(breakType) || !subtype.isActive)) {
            throw new AppError('Break subtype not found or inactive', 400);
        }
        if (subtype?.windowStart && subtype.windowEnd) {
            const nowMinutes = timeToMinutes(local.time)!;
            const startMinutes = timeToMinutes(subtype.windowStart)!;
            const endMinutes = timeToMinutes(subtype.windowEnd)!;
            if (nowMinutes < startMinutes || nowMinutes > endMinutes) {
                throw new AppError('Break cannot be started outside its configured window', 400);
            }
        }
        const user = await User.findById(employeeId, { attendancePrivilegeIds: 1 }).lean();
        const employeePrivileges = new Set((user?.attendancePrivilegeIds ?? []).map(String));
        const requiredPrivileges = (breakDoc.privilegeIds ?? []).length > 0
            ? breakDoc.privilegeIds
            : subtype?.privilegeIds ?? [];
        if (requiredPrivileges.length > 0 && !requiredPrivileges.some((id) => employeePrivileges.has(String(id)))) {
            throw new AppError('Employee is not eligible for this break', 403);
        }
    } else if (type === 'break_end') {
        const latestBreakStart = [...existingEvents].reverse().find((event) => event.type === 'break_start');
        breakType = latestBreakStart?.breakType;
        breakSubtype = latestBreakStart?.breakSubtype;
    }

    return AttendanceEvent.create({
        employee: employeeId,
        branch: branch._id,
        type,
        timestamp,
        branchLocalDate: local.date,
        branchLocalTime: local.time,
        branchTimezone: branch.timezone,
        breakType,
        breakSubtype,
        source: 'mobile',
        createdBy: employeeId,
        deviceId: req.body.deviceId,
        notes: req.body.notes,
    });
}

export const checkIn = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'check_in');
    res.status(201).json(event);
});

export const breakStart = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'break_start');
    res.status(201).json(event);
});

export const breakEnd = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'break_end');
    res.status(201).json(event);
});

export const checkOut = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'check_out');
    const snapshot = await generateDailySnapshot({
        employeeId: event.employee,
        branchId: event.branch,
        dateString: event.branchLocalDate,
        generatedBy: 'checkout',
    });
    res.status(201).json({ event, snapshot });
});

export const getMyDailySnapshots = ok(async (req, res) => {
    const employeeId = requireUserId(req);
    const query: Record<string, unknown> = { employee: employeeId };
    if (req.query.date) query.date = String(req.query.date);
    const items = await AttendanceDailySnapshot.find(query).sort({ date: -1 });
    res.status(200).json({ items });
});

export const getEmployeeDailySnapshots = ok(async (req, res) => {
    await assertManagerCanViewEmployee(req, req.params.employeeId);
    const query: Record<string, unknown> = { employee: toObjectId(req.params.employeeId, 'employeeId') };
    if (req.query.date) query.date = String(req.query.date);
    const items = await AttendanceDailySnapshot.find(query).sort({ date: -1 });
    res.status(200).json({ items });
});

export const getTeamDailySnapshots = ok(async (req, res) => {
    if (req.privilege === 'staff') throw new AppError('Not authorized', 403);
    const query: Record<string, unknown> = {};
    if (req.query.date) query.date = String(req.query.date);
    if (req.privilege === 'manager') {
        const staffIds = await User.find({ manager: req.userId }, { _id: 1 }).lean();
        query.employee = { $in: staffIds.map((staff) => staff._id) };
    }
    const items = await AttendanceDailySnapshot.find(query).sort({ date: -1 });
    res.status(200).json({ items });
});

export const finalizeDailySnapshots = ok(async (req, res) => {
    requireAdmin(req);
    const branchId = toObjectId(req.body.branchId, 'branchId');
    const branch = await Branch.findById(branchId).lean();
    if (!branch) throw new AppError('Branch not found', 404);
    const date = String(req.body.date ?? branchLocalParts(new Date(), branch.timezone).date);
    assertDate(date, 'date');
    const staffIds = (branch.staffs ?? []) as Types.ObjectId[];
    const createdSnapshots = [];
    for (const employeeId of staffIds) {
        const existing = await AttendanceDailySnapshot.findOne({ employee: employeeId, date });
        if (existing && !['missing_checkout', 'open_break', 'incomplete'].includes(existing.status)) continue;
        const snapshot = await generateDailySnapshot({
            employeeId,
            branchId,
            dateString: date,
            generatedBy: 'scheduled_job',
        });
        createdSnapshots.push(snapshot);
    }
    res.status(200).json({ createdSnapshots });
});

export const correctCheckout = ok(async (req, res) => {
    requireAdmin(req);
    const snapshot = await AttendanceDailySnapshot.findById(req.params.id);
    if (!snapshot) throw new AppError('Daily snapshot not found', 404);
    assertTime(req.body.checkoutTime, 'checkoutTime');
    const timestamp = branchLocalDateTimeToUtc(snapshot.date, req.body.checkoutTime, snapshot.branchTimezone);
    const local = branchLocalParts(timestamp, snapshot.branchTimezone);
    await AttendanceEvent.create({
        employee: snapshot.employee,
        branch: snapshot.branch,
        type: 'check_out',
        timestamp,
        branchLocalDate: snapshot.date,
        branchLocalTime: local.time,
        branchTimezone: snapshot.branchTimezone,
        source: 'admin',
        createdBy: requireUserId(req),
        notes: req.body.reason,
    });
    const regenerated = await generateDailySnapshot({
        employeeId: snapshot.employee,
        branchId: snapshot.branch,
        dateString: snapshot.date,
        generatedBy: 'correction',
        notes: req.body.reason,
    });
    res.status(200).json({ snapshot: regenerated });
});

export const getMonthlySummary = ok(async (req, res) => {
    await assertManagerCanViewEmployee(req, req.params.employeeId);
    const employeeId = toObjectId(req.params.employeeId, 'employeeId');
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('month must use YYYY-MM format', 400);
    const snapshots = await AttendanceDailySnapshot.find({
        employee: employeeId,
        date: { $regex: `^${month}` },
    }).sort({ date: 1 });
    const branch = snapshots[0]?.branch ?? (await getEmployeeBranch(employeeId))._id;
    const branchTimezone = snapshots[0]?.branchTimezone ?? 'Asia/Dubai';
    const summary = await AttendanceMonthlySummary.findOneAndUpdate(
        { employee: employeeId, month },
        {
            $set: {
                employee: employeeId,
                branch,
                month,
                branchTimezone,
                scheduledDays: snapshots.filter((s) => s.requiredWorkMinutes > 0).length,
                presentDays: snapshots.filter((s) => s.status === 'present').length,
                absentDays: snapshots.filter((s) => s.status === 'absent').length,
                offDays: snapshots.filter((s) => s.status === 'off_day').length,
                incompleteDays: snapshots.filter((s) => ['incomplete', 'missing_checkout', 'open_break'].includes(s.status)).length,
                requiredWorkMinutes: snapshots.reduce((sum, s) => sum + s.requiredWorkMinutes, 0),
                productiveWorkMinutes: snapshots.reduce((sum, s) => sum + s.productiveWorkMinutes, 0),
                grossMinutes: snapshots.reduce((sum, s) => sum + s.grossMinutes, 0),
                totalBreakMinutes: snapshots.reduce((sum, s) => sum + s.totalBreakMinutes, 0),
                breakOvertimeMinutes: snapshots.reduce((sum, s) => sum + s.breakOvertimeMinutes, 0),
                breakUndertimeMinutes: snapshots.reduce((sum, s) => sum + s.breakUndertimeMinutes, 0),
                overtimeMinutes: snapshots.reduce((sum, s) => sum + s.overtimeMinutes, 0),
                undertimeMinutes: snapshots.reduce((sum, s) => sum + s.undertimeMinutes, 0),
                lateMinutes: snapshots.reduce((sum, s) => sum + s.lateMinutes, 0),
                earlyLeaveMinutes: snapshots.reduce((sum, s) => sum + s.earlyLeaveMinutes, 0),
                generatedFromSnapshotIds: snapshots.map((s) => s._id),
                generatedAt: new Date(),
                version: 1,
            },
        },
        { new: true, upsert: true }
    );
    res.status(200).json(summary);
});
