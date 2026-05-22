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
import AttendanceDayOverride from '../../models/AttendanceDayOverride';
import AttendancePrivilege from '../../models/AttendancePrivilege';
import AttendanceBreakType, { AttendanceBreakSubtype } from '../../models/AttendanceBreak';
import AttendanceScheduleTemplate, {
    AttendanceScheduleAssignment,
    AttendanceScheduleGroup,
    AttendanceScheduleGroupMembership,
} from '../../models/AttendanceSchedule';
import AttendanceEvent, { IAttendanceEvent } from '../../models/AttendanceEvent';
import AttendanceDailySnapshot, {
    IAttendanceBreakSession,
    IAttendanceCalculationBasis,
} from '../../models/AttendanceDailySnapshot';
import AttendanceMonthlySummary from '../../models/AttendanceMonthlySummary';
import { hasFaceEnrollment } from '../../services/face-enrollment-service';
import { getCurrentBranchIdForUser } from '../../services/branch-context';

type GeneratedBy = 'event' | 'checkout' | 'scheduled_job' | 'correction' | 'manual';
type Actor = Pick<Request, 'userId' | 'privilege'>;
type ResolvedShift = {
    _id: Types.ObjectId;
    name?: string;
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
    source: 'employee' | 'group' | 'branch' | 'global' | 'shift_membership' | null;
    assignment: { _id: Types.ObjectId } | null;
    template: { _id: Types.ObjectId } | null;
    shiftMembership?: { _id: Types.ObjectId } | null;
    override?: { _id: Types.ObjectId; overrideType: 'hours' | 'off_day'; targetType?: string } | null;
    shifts: ResolvedShift[];
    scheduledSegments: Array<{ shift: Types.ObjectId; scheduledStart: string; scheduledEnd: string; requiredWorkMinutes: number }>;
    scheduledStart?: string;
    scheduledEnd?: string;
    requiredWorkMinutes: number;
};
type MyAttendanceWorkStatus = 'not_started' | 'checked_in' | 'on_break' | 'checked_out' | 'no_schedule';
type MyBreakOption = {
    breakTypeId: Types.ObjectId;
    breakTypeName: string;
    breakSubtypeId?: Types.ObjectId;
    breakSubtypeName?: string;
    windowStart?: string;
    windowEnd?: string;
    maxMinutesPerDay?: number;
    maxMinutesPerEvent?: number;
};

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const weekdays: AttendanceWeekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const attendanceLocationRadiusMeters = 100;

type AttendanceLocationProof = {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    distanceMeters: number;
    allowedRadiusMeters: number;
};

function shouldBypassAttendanceGate(branch: { attendanceEnabled?: boolean }) {
    return branch.attendanceEnabled !== true;
}

function serializeDailySnapshot(snapshot: any) {
    const value = typeof snapshot?.toObject === 'function' ? snapshot.toObject() : snapshot;
    const employee = value?.employee;
    const branch = value?.branch;
    const sessionsByBreakKey = new Map<string, any>();
    for (const session of value?.breakSessions ?? []) {
        const key = `${String(session.breakType ?? '')}:${String(session.breakSubtype ?? '')}`;
        if (!sessionsByBreakKey.has(key)) {
            sessionsByBreakKey.set(key, session);
        }
    }
    const breakTotals = (value?.breakTotals ?? []).map((total: any) => {
        const key = `${String(total.breakType ?? '')}:${String(total.breakSubtype ?? '')}`;
        const session = sessionsByBreakKey.get(key);
        return {
            ...total,
            breakTypeName: total.breakTypeName ?? session?.breakTypeName,
            breakSubtypeName: total.breakSubtypeName ?? session?.breakSubtypeName,
        };
    });
    return {
        ...value,
        employee: employee?._id ?? employee,
        employeeName: employee?.username,
        branch: branch?._id ?? branch,
        branchName: branch?.name,
        breakTotals,
    };
}

function serializeDailySnapshots(snapshots: any[]) {
    return snapshots.map(serializeDailySnapshot);
}

function isWithinWindow(currentMinutes: number, start?: string, end?: string) {
    if (!start || !end) return true;
    const startMinutes = timeToMinutes(start);
    const endMinutes = timeToMinutes(end);
    if (startMinutes === undefined || endMinutes === undefined) return false;
    if (startMinutes <= endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

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

async function getActorBranchId(req: Request) {
    if (req.privilege === 'admin') return undefined;
    if (req.privilege !== 'manager') {
        throw new AppError('Admin or manager privilege required', 403);
    }
    const branchId = await getCurrentBranchIdForUser(req.userId);
    if (!branchId) {
        throw new AppError('Manager branch not found', 403);
    }
    return branchId;
}

async function assertManagerBranch(req: Request) {
    const branchId = await getActorBranchId(req);
    if (!branchId) {
        throw new AppError('Manager branch not found', 403);
    }
    return branchId;
}

async function assertCanManageGroup(req: Request, group: { branch?: Types.ObjectId | string | null }) {
    if (req.privilege === 'admin') return;
    const actorBranchId = await assertManagerBranch(req);
    if (!group.branch || String(group.branch) !== String(actorBranchId)) {
        throw new AppError('Not authorized to manage this schedule group', 403);
    }
}

async function assertEmployeesInBranch(employeeIds: Types.ObjectId[], branchId: Types.ObjectId) {
    for (const employeeId of employeeIds) {
        const branch = await Branch.findOne({
            _id: branchId,
            $or: [
                { manager: employeeId },
                { staffs: employeeId },
            ],
        }, { _id: 1 }).lean();
        if (!branch) {
            throw new AppError('All selected employees must belong to the schedule group branch', 400);
        }
    }
}

async function assertEmployeesMatchGroupBranch(
    employeeIds: Types.ObjectId[],
    branchId?: Types.ObjectId | null,
) {
    if (!branchId) return;
    await assertEmployeesInBranch(employeeIds, branchId);
}

async function assertCanManageTemplate(req: Request, template: { branch?: Types.ObjectId | string | null }) {
    if (req.privilege === 'admin') return;
    const actorBranchId = await assertManagerBranch(req);
    if (!template.branch || String(template.branch) !== String(actorBranchId)) {
        throw new AppError('Not authorized to manage this schedule template', 403);
    }
}

async function assertCanManageAssignment(req: Request, assignment: {
    targetType: string;
    branch?: Types.ObjectId | string | null;
    group?: Types.ObjectId | string | null;
}) {
    if (req.privilege === 'admin') return;
    const actorBranchId = await assertManagerBranch(req);
    if (assignment.targetType === 'branch') {
        if (!assignment.branch || String(assignment.branch) !== String(actorBranchId)) {
            throw new AppError('Not authorized to manage this schedule assignment', 403);
        }
        return;
    }
    if (assignment.targetType === 'group') {
        const group = await AttendanceScheduleGroup.findById(assignment.group, { branch: 1 }).lean();
        if (!group || String(group.branch) !== String(actorBranchId)) {
            throw new AppError('Not authorized to manage this schedule assignment', 403);
        }
        return;
    }
    throw new AppError('Managers can only manage branch or group schedule assignments', 403);
}

async function assertManagerAssignmentPayload(req: Request, payload: {
    targetType: string;
    branchId?: string;
    groupId?: string;
}) {
    if (req.privilege !== 'manager') return;
    const actorBranchId = await assertManagerBranch(req);
    if (payload.targetType === 'global' || payload.targetType === 'employee') {
        throw new AppError('Managers can only create branch or group schedule assignments', 403);
    }
    if (payload.targetType === 'branch') {
        const branchId = toObjectId(payload.branchId, 'branchId');
        if (String(branchId) !== String(actorBranchId)) {
            throw new AppError('Managers can only assign schedules to their own branch', 403);
        }
    }
    if (payload.targetType === 'group') {
        const groupId = toObjectId(payload.groupId, 'groupId');
        const group = await AttendanceScheduleGroup.findById(groupId, { branch: 1 }).lean();
        if (!group || String(group.branch) !== String(actorBranchId)) {
            throw new AppError('Managers can only assign schedules to groups in their branch', 403);
        }
    }
}

function serializeScheduleTemplate(template: any) {
    const object = typeof template.toObject === 'function' ? template.toObject() : template;
    return {
        ...object,
        branchId: object.branch ? String(object.branch) : undefined,
    };
}

function serializeScheduleAssignment(assignment: any) {
    const object = typeof assignment.toObject === 'function' ? assignment.toObject() : assignment;
    return {
        ...object,
        templateId: String(object.template),
        branchId: object.branch ? String(object.branch) : undefined,
        groupId: object.group ? String(object.group) : undefined,
        employeeId: object.employee ? String(object.employee) : undefined,
    };
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

function parseCoordinate(value: unknown, fieldName: string, min: number, max: number) {
    if (value === null || value === undefined || value === '') {
        throw new AppError(`${fieldName} must be between ${min} and ${max}`, 400);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new AppError(`${fieldName} must be between ${min} and ${max}`, 400);
    }
    return parsed;
}

function distanceMeters(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }) {
    const earthRadiusMeters = 6371000;
    const toRadians = (value: number) => value * Math.PI / 180;
    const latitudeDelta = toRadians(to.latitude - from.latitude);
    const longitudeDelta = toRadians(to.longitude - from.longitude);
    const fromLatitude = toRadians(from.latitude);
    const toLatitude = toRadians(to.latitude);
    const a = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildAttendanceLocationProof(req: Request, branch: { location?: { latitude?: number; longitude?: number } }): AttendanceLocationProof {
    if (!branch.location || branch.location.latitude === undefined || branch.location.longitude === undefined) {
        throw new AppError('Branch location is required before attendance can be recorded', 400);
    }
    const rawLocation = req.body.location;
    if (!rawLocation || typeof rawLocation !== 'object' || Array.isArray(rawLocation)) {
        throw new AppError('Current location is required for attendance', 400);
    }
    const source = rawLocation as Record<string, unknown>;
    const latitude = parseCoordinate(source.latitude, 'location.latitude', -90, 90);
    const longitude = parseCoordinate(source.longitude, 'location.longitude', -180, 180);
    const accuracyMeters = parseCoordinate(source.accuracyMeters, 'location.accuracyMeters', 0, 100000);
    if (accuracyMeters > attendanceLocationRadiusMeters) {
        throw new AppError('GPS accuracy is too weak for attendance. Move to an open area and try again.', 400);
    }
    const distance = distanceMeters(
        { latitude, longitude },
        { latitude: branch.location.latitude, longitude: branch.location.longitude },
    );
    if (distance > attendanceLocationRadiusMeters) {
        throw new AppError('You are too far from the branch location to record attendance', 400);
    }
    return {
        latitude,
        longitude,
        accuracyMeters,
        distanceMeters: Math.round(distance),
        allowedRadiusMeters: attendanceLocationRadiusMeters,
    };
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

function emptyShiftWeeklyPattern(): IAttendanceShiftWeeklyPattern {
    return weekdays.reduce((pattern, weekday) => {
        pattern[weekday] = null;
        return pattern;
    }, {} as IAttendanceShiftWeeklyPattern);
}

function hasExplicitWeeklyPattern(body: Record<string, unknown>) {
    return body.weeklyPattern !== undefined && body.weeklyPattern !== null;
}

function normalizeWeeklyPattern(body: Record<string, unknown>): IAttendanceShiftWeeklyPattern {
    if (!hasExplicitWeeklyPattern(body)) {
        return emptyShiftWeeklyPattern();
    }

    if (typeof body.weeklyPattern !== 'object' || Array.isArray(body.weeklyPattern)) {
        throw new AppError('weeklyPattern must be an object', 400);
    }

    const source = body.weeklyPattern as Record<string, unknown>;
    return weekdays.reduce((pattern, weekday) => {
        pattern[weekday] = normalizeDayRule(source[weekday], `weeklyPattern.${weekday}`);
        return pattern;
    }, {} as IAttendanceShiftWeeklyPattern);
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

function hasWorkingSchedule(schedule: ResolvedSchedule) {
    return schedule.requiredWorkMinutes > 0 && schedule.scheduledSegments.length > 0 && schedule.override?.overrideType !== 'off_day';
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
        $or: [
            { staffs: employeeId },
            { manager: employeeId },
        ],
    });

    if (!branch) {
        throw new AppError('Employee does not belong to an active attendance branch', 400);
    }

    return branch;
}

function effectiveMembershipQuery(date: Date) {
    return {
        isActive: true,
        effectiveFrom: { $lte: date },
        $or: [
            { effectiveTo: { $exists: false } },
            { effectiveTo: null },
            { effectiveTo: { $gt: date } },
        ],
    };
}

function managedGroupMembershipQuery(asOf = new Date()) {
    return {
        isActive: true,
        $or: [
            { effectiveTo: { $exists: false } },
            { effectiveTo: null },
            { effectiveTo: { $gt: asOf } },
        ],
    };
}

function activeAssignmentQueryForRange(dayStart: Date, dayEnd: Date) {
    return {
        isActive: true,
        supersededAt: { $exists: false },
        effectiveFrom: { $lte: dayEnd },
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: dayStart } }],
    };
}

async function groupHasActiveScheduleAssignment(groupId: Types.ObjectId) {
    const assignment = await AttendanceScheduleAssignment.findOne({
        targetType: 'group',
        group: groupId,
        isActive: true,
        supersededAt: { $exists: false },
    }).lean();
    return !!assignment;
}

async function membershipEffectiveDateForEmployees(groupId: Types.ObjectId, employeeIds: Types.ObjectId[]) {
    if (!(await groupHasActiveScheduleAssignment(groupId)) || employeeIds.length === 0) {
        return new Date();
    }

    const branches = await Branch.find({
        isActive: true,
        $or: [
            { manager: { $in: employeeIds } },
            { staffs: { $in: employeeIds } },
        ],
    }).lean();
    const boundaries = employeeIds.map((employeeId) => {
        const branch = branches.find((item) => branchContainsEmployeeOrManager(item, employeeId));
        return nextBranchLocalDayBoundaryUtc(branch?.timezone ?? 'Asia/Dubai');
    });
    return new Date(Math.min(...boundaries.map((item) => item.getTime())));
}

function branchContainsEmployeeOrManager(
    branch: { manager?: Types.ObjectId | null; staffs?: Types.ObjectId[] },
    employeeId: Types.ObjectId | string
) {
    const id = String(employeeId);
    return String(branch.manager ?? '') === id ||
        (branch.staffs ?? []).some((staffId) => String(staffId) === id);
}

async function branchesForEmployees(employeeIds: Array<Types.ObjectId | string>) {
    if (employeeIds.length === 0) return [];
    return Branch.find({
        $or: [
            { manager: { $in: employeeIds } },
            { staffs: { $in: employeeIds } },
        ],
    }, { name: 1, manager: 1, staffs: 1 }).lean();
}

async function scheduleGroupSummary(group: any, asOf = new Date(), managementView = true) {
    const memberships = await AttendanceScheduleGroupMembership.find({
        group: group._id,
        ...(managementView
            ? managedGroupMembershipQuery(asOf)
            : effectiveMembershipQuery(asOf)),
    }).populate('employee', 'username isActive').lean();
    const employeeIds = memberships.map((membership) => membership.employee?._id ?? membership.employee);
    const memberBranches = await branchesForEmployees(employeeIds);
    const activeAssignment = await AttendanceScheduleAssignment.findOne({
        targetType: 'group',
        group: group._id,
        isActive: true,
        supersededAt: { $exists: false },
    }, { _id: 1 }).lean();

    const groupObject = typeof group.toObject === 'function' ? group.toObject() : group;
    const storedBranchId = groupObject.branch ? String(groupObject.branch) : undefined;
    const storedBranch = storedBranchId
        ? await Branch.findById(storedBranchId, { name: 1 }).lean()
        : null;
    const branchIds = storedBranchId
        ? [storedBranchId]
        : memberBranches.map((branch) => String(branch._id));
    const branchNames = storedBranch
        ? [storedBranch.name]
        : memberBranches.map((branch) => branch.name);

    return {
        ...groupObject,
        branchId: storedBranchId,
        branchName: storedBranch?.name,
        memberCount: memberships.length,
        branchIds,
        branchNames,
        hasActiveAssignment: !!activeAssignment,
    };
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

    let rule = ruleFromShiftForWeekday(shift, branchLocalWeekday(dateString, branch.timezone));

    const resolvedShift: ResolvedShift | null = rule
        ? {
            _id: shift._id,
            name: shift.name,
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
        override: null,
        shifts: resolvedShift ? [resolvedShift] : [],
        scheduledSegments,
        scheduledStart: scheduledSegments[0]?.scheduledStart,
        scheduledEnd: scheduledSegments[scheduledSegments.length - 1]?.scheduledEnd,
        requiredWorkMinutes: scheduledSegments.reduce((sum, segment) => sum + segment.requiredWorkMinutes, 0),
    };
}

async function findApplicableDayOverride(
    employeeId: Types.ObjectId,
    branchId: Types.ObjectId,
    dateString: string,
    groupId?: Types.ObjectId
) {
    const activeQuery = {
        date: dateString,
        isActive: true,
        $or: [{ supersededAt: { $exists: false } }, { supersededAt: null }],
    };
    const candidates: Array<Record<string, unknown>> = [
        { targetType: 'employee', employee: employeeId },
        ...(groupId ? [{ targetType: 'group', group: groupId }] : []),
        { targetType: 'branch', branch: branchId },
        { targetType: 'global' },
    ];

    for (const candidate of candidates) {
        const override = await AttendanceDayOverride.findOne({
            ...activeQuery,
            ...candidate,
        }).sort({ version: -1, createdAt: -1 }).lean();
        if (override) return override;
    }
    return null;
}

async function applyDayOverride(
    schedule: ResolvedSchedule,
    employeeId: Types.ObjectId,
    branchId: Types.ObjectId,
    dateString: string,
    groupId?: Types.ObjectId
): Promise<ResolvedSchedule> {
    const override = await findApplicableDayOverride(employeeId, branchId, dateString, groupId);
    if (!override) return schedule;

    if (override.overrideType === 'off_day') {
        return {
            ...schedule,
            override: { _id: override._id, overrideType: override.overrideType, targetType: override.targetType },
            shifts: [],
            scheduledSegments: [],
            scheduledStart: undefined,
            scheduledEnd: undefined,
            requiredWorkMinutes: 0,
        };
    }

    const scheduledSegments = [{
        shift: override._id,
        scheduledStart: override.startTime!,
        scheduledEnd: override.endTime!,
        requiredWorkMinutes: override.requiredWorkMinutes,
    }];
    return {
        ...schedule,
        override: { _id: override._id, overrideType: override.overrideType, targetType: override.targetType },
        shifts: [],
        scheduledSegments,
        scheduledStart: override.startTime,
        scheduledEnd: override.endTime,
        requiredWorkMinutes: override.requiredWorkMinutes,
    };
}

async function resolveSchedule(employeeId: Types.ObjectId, branchId: Types.ObjectId, dateString: string): Promise<ResolvedSchedule> {
    assertDate(dateString, 'date');
    const branch = await Branch.findById(branchId).lean();
    if (!branch) throw new AppError('Branch not found', 404);

    const dayStart = new Date(`${dateString}T00:00:00.000Z`);
    const dayEnd = new Date(`${dateString}T23:59:59.999Z`);
    const groupMembership = await AttendanceScheduleGroupMembership.findOne({
        employee: employeeId,
        ...effectiveMembershipQuery(dayEnd),
    }).sort({ effectiveFrom: -1 }).lean();

    const workingShiftSchedule = await resolveWorkingShiftSchedule(employeeId, branch, dateString);
    if (workingShiftSchedule) {
        return applyDayOverride(
            workingShiftSchedule,
            employeeId,
            branchId,
            dateString,
            groupMembership?.group
        );
    }

    const assignmentQuery = activeAssignmentQueryForRange(dayStart, dayEnd);

    const candidates: Array<{
        source: 'employee' | 'group' | 'branch' | 'global';
        query: Record<string, unknown>;
    }> = [
        { source: 'employee', query: { targetType: 'employee', employee: employeeId } },
        ...(groupMembership
            ? [{ source: 'group' as const, query: { targetType: 'group', group: groupMembership.group } }]
            : []),
        { source: 'branch', query: { targetType: 'branch', branch: branchId } },
        { source: 'global', query: { targetType: 'global' } },
    ];

    let source: 'employee' | 'group' | 'branch' | 'global' = 'global';
    let assignment: any = null;
    let template: any = null;

    for (const candidate of candidates) {
        const foundAssignment = await AttendanceScheduleAssignment.findOne({
            ...assignmentQuery,
            ...candidate.query,
        }).sort({ effectiveFrom: -1 });
        const foundTemplate = foundAssignment
            ? await AttendanceScheduleTemplate.findOne({ _id: foundAssignment.template, isActive: true }).lean()
            : null;
        if (foundAssignment && foundTemplate) {
            source = candidate.source;
            assignment = foundAssignment;
            template = foundTemplate;
            break;
        }
    }

    if (!assignment || !template) {
        return applyDayOverride({
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
        }, employeeId, branchId, dateString, groupMembership?.group);
    }

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

    return applyDayOverride({
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
    }, employeeId, branchId, dateString, groupMembership?.group);
}

async function getDayEvents(employeeId: Types.ObjectId, dateString: string) {
    return AttendanceEvent.find({
        employee: employeeId,
        branchLocalDate: dateString,
    }).sort({ timestamp: 1 });
}

function splitAttendanceEvents(events: Awaited<ReturnType<typeof getDayEvents>>) {
    const firstCheckIn = events.find((event) => event.type === 'check_in');
    const checkOuts = events.filter((event) => event.type === 'check_out');
    const lastCheckOut = checkOuts[checkOuts.length - 1];
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

    return {
        firstCheckIn,
        lastCheckOut,
        openBreak: openBreakStack[openBreakStack.length - 1],
        openBreakCount: openBreakStack.length,
        breakPairs,
    };
}

function maybeObjectId(value: unknown): Types.ObjectId | undefined {
    if (!value) return undefined;
    if (value instanceof Types.ObjectId) return value;
    const candidate = typeof value === 'object' && '_id' in (value as Record<string, unknown>)
        ? (value as Record<string, unknown>)._id
        : value;
    const asString = String(candidate);
    return Types.ObjectId.isValid(asString) ? new Types.ObjectId(asString) : undefined;
}

function captureCalculationBasis(schedule: ResolvedSchedule): IAttendanceCalculationBasis {
    const shiftById = new Map(schedule.shifts.map((shift) => [String(shift._id), shift]));
    const dayOverride = schedule.override
        ? {
            overrideId: schedule.override._id,
            targetType: schedule.override.targetType ?? '',
            overrideType: schedule.override.overrideType,
            startTime: schedule.scheduledStart,
            endTime: schedule.scheduledEnd,
            requiredWorkMinutes: schedule.requiredWorkMinutes,
        }
        : undefined;

    return {
        schemaVersion: 1,
        capturedAt: new Date(),
        source: schedule.source,
        branchTimezone: schedule.branchTimezone,
        scheduleAssignment: schedule.assignment?._id,
        scheduleTemplate: schedule.template?._id,
        shiftMembership: schedule.shiftMembership?._id,
        dayOverride,
        scheduledSegments: schedule.scheduledSegments.map((segment) => {
            const shift = shiftById.get(String(segment.shift));
            return {
                shiftId: shift?._id,
                shiftName: shift?.name,
                shiftVersion: shift?.version,
                scheduledStart: segment.scheduledStart,
                scheduledEnd: segment.scheduledEnd,
                requiredWorkMinutes: segment.requiredWorkMinutes,
                graceLateMinutes: shift?.graceLateMinutes ?? 0,
                graceEarlyLeaveMinutes: shift?.graceEarlyLeaveMinutes ?? 0,
            };
        }),
        scheduledStart: schedule.scheduledStart,
        scheduledEnd: schedule.scheduledEnd,
        requiredWorkMinutes: schedule.requiredWorkMinutes,
    } as IAttendanceCalculationBasis;
}

function scheduleFromCalculationBasis(
    basis: IAttendanceCalculationBasis,
    employeeId: Types.ObjectId,
    branchId: Types.ObjectId
): ResolvedSchedule {
    const fallbackSegmentId = maybeObjectId(basis.dayOverride?.overrideId);
    const shifts = (basis.scheduledSegments ?? [])
        .map((segment) => {
            const shiftId = maybeObjectId(segment.shiftId);
            return shiftId
                ? {
                    _id: shiftId,
                    name: segment.shiftName,
                    version: segment.shiftVersion,
                    startTime: segment.scheduledStart,
                    endTime: segment.scheduledEnd,
                    requiredWorkMinutes: segment.requiredWorkMinutes,
                    graceLateMinutes: segment.graceLateMinutes,
                    graceEarlyLeaveMinutes: segment.graceEarlyLeaveMinutes,
                }
                : null;
        })
        .filter(Boolean) as ResolvedShift[];
    const scheduledSegments = (basis.scheduledSegments ?? [])
        .map((segment) => {
            const shift = maybeObjectId(segment.shiftId) ?? fallbackSegmentId;
            return shift
                ? {
                    shift,
                    scheduledStart: segment.scheduledStart,
                    scheduledEnd: segment.scheduledEnd,
                    requiredWorkMinutes: segment.requiredWorkMinutes,
                }
                : null;
        })
        .filter(Boolean) as ResolvedSchedule['scheduledSegments'];

    return {
        employeeId: String(employeeId),
        branchId: String(branchId),
        branchTimezone: basis.branchTimezone,
        source: basis.source ?? null,
        assignment: basis.scheduleAssignment ? { _id: maybeObjectId(basis.scheduleAssignment)! } : null,
        template: basis.scheduleTemplate ? { _id: maybeObjectId(basis.scheduleTemplate)! } : null,
        shiftMembership: basis.shiftMembership ? { _id: maybeObjectId(basis.shiftMembership)! } : null,
        override: basis.dayOverride
            ? {
                _id: maybeObjectId(basis.dayOverride.overrideId)!,
                overrideType: basis.dayOverride.overrideType,
                targetType: basis.dayOverride.targetType,
            }
            : null,
        shifts,
        scheduledSegments,
        scheduledStart: basis.scheduledStart,
        scheduledEnd: basis.scheduledEnd,
        requiredWorkMinutes: basis.requiredWorkMinutes,
    };
}

async function currentBreakRuleBasis(start: Awaited<ReturnType<typeof getDayEvents>>[number]) {
    const breakType = start.breakType
        ? await AttendanceBreakType.findById(start.breakType).lean()
        : null;
    const breakSubtype = start.breakSubtype
        ? await AttendanceBreakSubtype.findById(start.breakSubtype).lean()
        : null;
    return {
        breakTypeName: breakType?.name,
        breakSubtypeName: breakSubtype?.name,
        maxMinutesPerDay: breakType?.maxMinutesPerDay,
        maxMinutesPerEvent: breakSubtype?.maxMinutesPerEvent,
    };
}

async function resolveStartableBreakOptions(employeeId: Types.ObjectId, timezone: string): Promise<MyBreakOption[]> {
    const nowLocal = branchLocalParts(new Date(), timezone);
    const nowMinutes = timeToMinutes(nowLocal.time);
    if (nowMinutes === undefined) return [];

    const [user, breakTypes, breakSubtypes] = await Promise.all([
        User.findById(employeeId, { attendancePrivilegeIds: 1 }).lean(),
        AttendanceBreakType.find({ isActive: true }).sort({ name: 1 }).lean(),
        AttendanceBreakSubtype.find({ isActive: true }).sort({ name: 1 }).lean(),
    ]);

    const employeePrivileges = new Set((user?.attendancePrivilegeIds ?? []).map(String));
    const subtypesByParent = new Map<string, typeof breakSubtypes>();
    for (const subtype of breakSubtypes) {
        const parentId = String(subtype.parentBreak);
        subtypesByParent.set(parentId, [...(subtypesByParent.get(parentId) ?? []), subtype]);
    }

    const options: MyBreakOption[] = [];
    for (const breakType of breakTypes) {
        const parentPrivilegeIds = (breakType.privilegeIds ?? []).map(String);
        const parentEligible =
            parentPrivilegeIds.length === 0 ||
            parentPrivilegeIds.some((id) => employeePrivileges.has(id));
        if (!parentEligible) continue;

        const subtypes = subtypesByParent.get(String(breakType._id)) ?? [];
        if (subtypes.length === 0) {
            options.push({
                breakTypeId: breakType._id,
                breakTypeName: breakType.name,
                maxMinutesPerDay: breakType.maxMinutesPerDay,
            });
            continue;
        }

        for (const subtype of subtypes) {
            const subtypePrivilegeIds = subtype.inheritsParentPrivilege
                ? parentPrivilegeIds
                : (subtype.privilegeIds ?? []).map(String);
            const subtypeEligible =
                subtypePrivilegeIds.length === 0 ||
                subtypePrivilegeIds.some((id) => employeePrivileges.has(id));
            if (!subtypeEligible) continue;
            if (!isWithinWindow(nowMinutes, subtype.windowStart, subtype.windowEnd)) continue;

            options.push({
                breakTypeId: breakType._id,
                breakTypeName: breakType.name,
                breakSubtypeId: subtype._id,
                breakSubtypeName: subtype.name,
                windowStart: subtype.windowStart,
                windowEnd: subtype.windowEnd,
                maxMinutesPerDay: breakType.maxMinutesPerDay,
                maxMinutesPerEvent: subtype.maxMinutesPerEvent,
            });
        }
    }
    return options;
}

async function calculateBreakSessions(
    breakPairs: Array<{ start: Awaited<ReturnType<typeof getDayEvents>>[number]; end: Awaited<ReturnType<typeof getDayEvents>>[number] }>,
    timezone: string,
    existingSessions: IAttendanceBreakSession[],
    reuseFrozenRules: boolean
) {
    const existingByPair = new Map(
        (existingSessions ?? []).map((session) => [
            `${String(session.startEventId)}:${String(session.endEventId)}`,
            session,
        ])
    );
    const dailyBreakUsage = new Map<string, number>();
    let totalBreakMinutes = 0;
    let breakOvertimeMinutes = 0;
    let breakUndertimeMinutes = 0;
    const breakSessions: IAttendanceBreakSession[] = [];
    const breakTotals: Array<Record<string, unknown>> = [];

    for (const pair of breakPairs) {
        const actualMinutes = minutesBetween(pair.start.timestamp, pair.end.timestamp);
        totalBreakMinutes += actualMinutes;

        const pairKey = `${String(pair.start._id)}:${String(pair.end._id)}`;
        const existing = reuseFrozenRules ? existingByPair.get(pairKey) : undefined;
        const basis = existing ?? await currentBreakRuleBasis(pair.start);
        const dailyKey = String(pair.start.breakType ?? 'unknown');
        const dailyUsed = dailyBreakUsage.get(dailyKey) ?? 0;
        const dailyLimit = basis.maxMinutesPerDay ?? Number.POSITIVE_INFINITY;
        const perEventLimit = basis.maxMinutesPerEvent ?? Number.POSITIVE_INFINITY;
        const remainingDaily = Math.max(0, dailyLimit - dailyUsed);
        const allowedBudget = Math.min(perEventLimit, remainingDaily);
        const normalizedAllowedBudget = Number.isFinite(allowedBudget) ? allowedBudget : actualMinutes;
        const allowedMinutes = Math.min(actualMinutes, normalizedAllowedBudget);
        const excessMinutes = Math.max(0, actualMinutes - normalizedAllowedBudget);
        const unusedAllowedMinutes = Math.max(0, normalizedAllowedBudget - actualMinutes);
        const startLocal = branchLocalParts(pair.start.timestamp, timezone);
        const endLocal = branchLocalParts(pair.end.timestamp, timezone);

        dailyBreakUsage.set(dailyKey, dailyUsed + allowedMinutes);
        breakOvertimeMinutes += unusedAllowedMinutes;
        breakUndertimeMinutes += excessMinutes;

        const session = {
            startEventId: pair.start._id,
            endEventId: pair.end._id,
            startAt: pair.start.timestamp,
            endAt: pair.end.timestamp,
            startLocalTime: startLocal.time,
            endLocalTime: endLocal.time,
            breakType: pair.start.breakType,
            breakTypeName: basis.breakTypeName,
            breakSubtype: pair.start.breakSubtype,
            breakSubtypeName: basis.breakSubtypeName,
            maxMinutesPerDay: basis.maxMinutesPerDay,
            maxMinutesPerEvent: basis.maxMinutesPerEvent,
            minutes: actualMinutes,
            allowedMinutes,
            excessMinutes,
            unusedAllowedMinutes,
            overtimeMinutes: unusedAllowedMinutes,
            undertimeMinutes: excessMinutes,
        } as IAttendanceBreakSession;
        breakSessions.push(session);
        breakTotals.push({
            breakType: session.breakType,
            breakTypeName: session.breakTypeName,
            breakSubtype: session.breakSubtype,
            breakSubtypeName: session.breakSubtypeName,
            minutes: session.minutes,
            allowedMinutes: session.allowedMinutes,
            excessMinutes: session.excessMinutes,
            unusedAllowedMinutes: session.unusedAllowedMinutes,
            overtimeMinutes: session.overtimeMinutes,
            undertimeMinutes: session.undertimeMinutes,
        });
    }

    return {
        totalBreakMinutes,
        breakOvertimeMinutes,
        breakUndertimeMinutes,
        breakSessions,
        breakTotals,
    };
}

async function generateDailySnapshot(params: {
    employeeId: Types.ObjectId;
    branchId: Types.ObjectId;
    dateString: string;
    generatedBy: GeneratedBy;
    notes?: string;
    recalculateBasis?: boolean;
}) {
    const existing = await AttendanceDailySnapshot.findOne({
        employee: params.employeeId,
        date: params.dateString,
    });
    const shouldReuseBasis = !params.recalculateBasis && existing?.calculationBasis;
    const schedule = shouldReuseBasis
        ? scheduleFromCalculationBasis(existing.calculationBasis as IAttendanceCalculationBasis, params.employeeId, params.branchId)
        : await resolveSchedule(params.employeeId, params.branchId, params.dateString);
    const calculationBasis = shouldReuseBasis
        ? existing.calculationBasis
        : captureCalculationBasis(schedule);
    const events = await getDayEvents(params.employeeId, params.dateString);
    const { firstCheckIn, lastCheckOut, openBreakCount, breakPairs } = splitAttendanceEvents(events);

    let status: 'present' | 'absent' | 'off_day' | 'incomplete' | 'missing_checkout' | 'open_break';
    let grossMinutes = 0;
    let productiveWorkMinutes = 0;

    if (!firstCheckIn && schedule.requiredWorkMinutes === 0) {
        status = 'off_day';
    } else if (!firstCheckIn) {
        status = 'absent';
    } else if (openBreakCount > 0) {
        status = 'open_break';
    } else if (!lastCheckOut) {
        status = ['scheduled_job', 'manual'].includes(params.generatedBy) ? 'missing_checkout' : 'incomplete';
    } else {
        status = 'present';
    }

    const breakCalculation = await calculateBreakSessions(
        breakPairs,
        schedule.branchTimezone,
        existing?.breakSessions ?? [],
        !params.recalculateBasis
    );

    if (firstCheckIn && lastCheckOut) {
        grossMinutes = minutesBetween(firstCheckIn.timestamp, lastCheckOut.timestamp);
        productiveWorkMinutes = Math.max(0, grossMinutes - breakCalculation.totalBreakMinutes);
    }

    const isClosedWorkSession = Boolean(firstCheckIn && lastCheckOut);
    const shouldCalculateWorkDelta = isClosedWorkSession || status === 'absent';
    const overtimeMinutes = shouldCalculateWorkDelta
        ? Math.max(0, productiveWorkMinutes - schedule.requiredWorkMinutes)
        : 0;
    const undertimeMinutes = shouldCalculateWorkDelta
        ? Math.max(0, schedule.requiredWorkMinutes - productiveWorkMinutes)
        : 0;
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
        totalBreakMinutes: breakCalculation.totalBreakMinutes,
        breakOvertimeMinutes: breakCalculation.breakOvertimeMinutes,
        breakUndertimeMinutes: breakCalculation.breakUndertimeMinutes,
        overtimeMinutes,
        undertimeMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        breakTotals: breakCalculation.breakTotals,
        breakSessions: breakCalculation.breakSessions,
        calculationBasis,
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

async function generateDailySnapshotFromEvent(event: IAttendanceEvent) {
    return generateDailySnapshot({
        employeeId: event.employee,
        branchId: event.branch,
        dateString: event.branchLocalDate,
        generatedBy: 'event',
    });
}

function latestOpenBreakStart(events: Awaited<ReturnType<typeof getDayEvents>>) {
    const openBreakStack: typeof events = [];
    for (const event of events) {
        if (event.type === 'break_start') {
            openBreakStack.push(event);
        } else if (event.type === 'break_end') {
            openBreakStack.pop();
        }
    }
    return openBreakStack[openBreakStack.length - 1];
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
    const hasWeeklyPattern = hasExplicitWeeklyPattern(req.body);
    const weeklyPattern = normalizeWeeklyPattern(req.body);
    const firstRule = firstWorkingRule(weeklyPattern);
    if (hasWeeklyPattern && !firstRule) throw new AppError('At least one working day is required', 400);
    if (!hasWeeklyPattern) {
        assertTime(req.body.startTime, 'startTime');
        assertTime(req.body.endTime, 'endTime');
    }
    const requiredWorkMinutes = hasWeeklyPattern
        ? req.body.requiredWorkMinutes ?? firstRule!.requiredWorkMinutes
        : numberOrDefault(req.body.requiredWorkMinutes, 0);
    const shift = await AttendanceShift.create({
        name: req.body.name,
        startTime: req.body.startTime ?? firstRule!.startTime,
        endTime: req.body.endTime ?? firstRule!.endTime,
        requiredWorkMinutes,
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
    const hasWeeklyPattern = hasExplicitWeeklyPattern(req.body);
    if (hasWeeklyPattern) {
        const bodyForPattern = {
            startTime: req.body.startTime ?? existing.startTime,
            endTime: req.body.endTime ?? existing.endTime,
            requiredWorkMinutes: req.body.requiredWorkMinutes ?? existing.requiredWorkMinutes,
            weeklyPattern: req.body.weeklyPattern,
        };
        const weeklyPattern = normalizeWeeklyPattern(bodyForPattern);
        const firstRule = firstWorkingRule(weeklyPattern);
        if (!firstRule) throw new AppError('At least one working day is required', 400);
        update.weeklyPattern = weeklyPattern;
        update.startTime = req.body.startTime ?? firstRule.startTime;
        update.endTime = req.body.endTime ?? firstRule.endTime;
        update.requiredWorkMinutes = req.body.requiredWorkMinutes ?? firstRule.requiredWorkMinutes;
    } else if (req.body.startTime || req.body.endTime || req.body.requiredWorkMinutes !== undefined) {
        const startTime = req.body.startTime ?? existing.startTime;
        const endTime = req.body.endTime ?? existing.endTime;
        assertTime(startTime, 'startTime');
        assertTime(endTime, 'endTime');
        update.startTime = startTime;
        update.endTime = endTime;
        update.requiredWorkMinutes = numberOrDefault(
            req.body.requiredWorkMinutes ?? existing.requiredWorkMinutes,
            0
        );
        update.weeklyPattern = emptyShiftWeeklyPattern();
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

type DayOverrideTargetType = 'global' | 'branch' | 'group' | 'employee';
type DayOverrideType = 'hours' | 'off_day';

function normalizeOverrideDates(body: Record<string, unknown>) {
    const rawDates = Array.isArray(body.dates) ? body.dates : body.date ? [body.date] : [];
    const dates = (Array.from(new Set(rawDates.map(String))) as string[]);
    if (dates.length === 0) throw new AppError('At least one date is required', 400);
    dates.forEach((date) => assertDate(date, 'dates'));
    return dates;
}

async function resolveDayOverrideTarget(body: Record<string, unknown>) {
    if (!['global', 'branch', 'group', 'employee'].includes(String(body.targetType))) {
        throw new AppError('targetType must be global, branch, group, or employee', 400);
    }
    const targetType = String(body.targetType) as DayOverrideTargetType;
    const branch = targetType === 'branch' ? toObjectId(body.branchId, 'branchId') : undefined;
    const group = targetType === 'group' ? toObjectId(body.groupId, 'groupId') : undefined;
    const employee = targetType === 'employee' ? toObjectId(body.employeeId, 'employeeId') : undefined;

    let targetName = 'Global';
    if (branch) {
        const doc = await Branch.findById(branch, { name: 1, isActive: 1 }).lean();
        if (!doc || !doc.isActive) throw new AppError('Branch not found or inactive', 404);
        targetName = doc.name;
    }
    if (group) {
        const doc = await AttendanceScheduleGroup.findById(group, { name: 1, isActive: 1 }).lean();
        if (!doc || !doc.isActive) throw new AppError('Schedule group not found or inactive', 404);
        targetName = doc.name;
    }
    if (employee) {
        const doc = await User.findById(employee, { username: 1, isActive: 1 }).lean();
        if (!doc || !doc.isActive) throw new AppError('Employee not found or inactive', 404);
        targetName = doc.username;
    }
    return { targetType, branch, group, employee, targetName };
}

function dayOverrideConflictFilter(params: {
    targetType: DayOverrideTargetType;
    date: string;
    branch?: Types.ObjectId;
    group?: Types.ObjectId;
    employee?: Types.ObjectId;
}) {
    const base: Record<string, unknown> = {
        targetType: params.targetType,
        date: params.date,
        isActive: true,
        $or: [{ supersededAt: { $exists: false } }, { supersededAt: null }],
    };
    if (params.branch) base.branch = params.branch;
    if (params.group) base.group = params.group;
    if (params.employee) base.employee = params.employee;
    return base;
}

async function dayOverrideConflicts(body: Record<string, unknown>) {
    const dates = normalizeOverrideDates(body);
    const target = await resolveDayOverrideTarget(body);
    const conflicts = [];
    for (const date of dates) {
        const existing = await AttendanceDayOverride.find(
            dayOverrideConflictFilter({ ...target, date })
        ).sort({ version: -1, createdAt: -1 }).lean();
        conflicts.push(...existing.map((item) => ({
            overrideId: String(item._id),
            date,
            targetType: target.targetType,
            targetName: target.targetName,
            overrideType: item.overrideType,
        })));
    }
    return { dates, target, conflicts };
}

export const previewDayOverrides = ok(async (req, res) => {
    requireAdmin(req);
    const { conflicts } = await dayOverrideConflicts(req.body);
    res.status(200).json({ conflicts });
});

export const createDayOverrides = ok(async (req, res) => {
    requireAdmin(req);
    const createdBy = requireUserId(req);
    if (!['hours', 'off_day'].includes(req.body.overrideType)) {
        throw new AppError('overrideType must be hours or off_day', 400);
    }
    const overrideType = req.body.overrideType as DayOverrideType;
    if (overrideType === 'hours') {
        assertTime(req.body.startTime, 'startTime');
        assertTime(req.body.endTime, 'endTime');
    }

    const { dates, target, conflicts } = await dayOverrideConflicts(req.body);
    if (conflicts.length > 0 && req.body.confirmConflicts !== true) {
        res.status(409).json({
            message: 'One or more active day overrides already exist for this target and date',
            conflicts,
        });
        return;
    }

    const created = [];
    for (const date of dates) {
        const existing = await AttendanceDayOverride.find(
            dayOverrideConflictFilter({ ...target, date })
        ).sort({ version: -1 });
        if (existing.length > 0) {
            await AttendanceDayOverride.updateMany(
                { _id: { $in: existing.map((item) => item._id) } },
                { $set: { isActive: false, supersededAt: new Date() } }
            );
        }
        created.push(await AttendanceDayOverride.create({
            targetType: target.targetType,
            branch: target.branch,
            group: target.group,
            employee: target.employee,
            date,
            overrideType,
            startTime: overrideType === 'hours' ? req.body.startTime : undefined,
            endTime: overrideType === 'hours' ? req.body.endTime : undefined,
            requiredWorkMinutes: overrideType === 'hours' ? numberOrDefault(req.body.requiredWorkMinutes, 0) : 0,
            note: req.body.note,
            version: existing[0] ? existing[0].version + 1 : 1,
            isActive: true,
            createdBy,
        }));
    }
    res.status(201).json({ items: created, conflicts });
});

export const listDayOverrides = ok(async (req, res) => {
    requireAdmin(req);
    const query: Record<string, unknown> = {};
    const includeHistory = ['true', '1', 'yes'].includes(String(req.query.includeHistory ?? '').toLowerCase());
    if (req.query.branchId) query.branch = toObjectId(req.query.branchId, 'branchId');
    if (req.query.groupId) query.group = toObjectId(req.query.groupId, 'groupId');
    if (req.query.employeeId) query.employee = toObjectId(req.query.employeeId, 'employeeId');
    if (req.query.date) {
        assertDate(req.query.date, 'date');
        query.date = String(req.query.date);
    } else if (!includeHistory) {
        query.date = { $gte: new Date().toISOString().slice(0, 10) };
    }
    if (req.query.isActive !== undefined) {
        query.isActive = String(req.query.isActive) !== 'false';
    } else if (!includeHistory) {
        query.isActive = true;
    }
    if (!includeHistory) {
        query.$or = [{ supersededAt: { $exists: false } }, { supersededAt: null }];
    }
    const items = await AttendanceDayOverride.find(query)
        .populate('group', 'name isActive')
        .populate('employee', 'username privilege isActive')
        .populate('branch', 'name timezone isActive')
        .sort({ date: -1, createdAt: -1 });
    res.status(200).json({ items });
});

export const updateDayOverride = ok(async (req, res) => {
    requireAdmin(req);
    const override = await AttendanceDayOverride.findById(req.params.id);
    if (!override) throw new AppError('Day override not found', 404);

    const targetType = String(req.body.targetType ?? override.targetType) as DayOverrideTargetType;
    const target = await resolveDayOverrideTarget({
        targetType,
        branchId: req.body.branchId ?? (override.branch ? String(override.branch) : undefined),
        groupId: req.body.groupId ?? (override.group ? String(override.group) : undefined),
        employeeId: req.body.employeeId ?? (override.employee ? String(override.employee) : undefined),
    });
    const date = String(req.body.date ?? override.date);
    assertDate(date, 'date');
    const overrideType = String(req.body.overrideType ?? override.overrideType) as DayOverrideType;
    if (!['hours', 'off_day'].includes(overrideType)) {
        throw new AppError('overrideType must be hours or off_day', 400);
    }
    const isActive = req.body.isActive === undefined ? override.isActive : req.body.isActive === true;
    const willBeSuperseded = isActive
        ? req.body.supersededAt ? parseDate(req.body.supersededAt, 'supersededAt') : undefined
        : (override.supersededAt ?? new Date());

    if (isActive && !willBeSuperseded) {
        const conflict = await AttendanceDayOverride.findOne({
            ...dayOverrideConflictFilter({ ...target, date }),
            _id: { $ne: override._id },
        }).lean();
        if (conflict) {
            throw new AppError('An active day override already exists for this target and date', 409);
        }
    }

    override.targetType = target.targetType;
    override.branch = target.branch;
    override.group = target.group;
    override.employee = target.employee;
    override.date = date;
    override.overrideType = overrideType;
    override.startTime = overrideType === 'hours' ? String(req.body.startTime ?? override.startTime) : undefined;
    override.endTime = overrideType === 'hours' ? String(req.body.endTime ?? override.endTime) : undefined;
    if (overrideType === 'hours') {
        assertTime(override.startTime, 'startTime');
        assertTime(override.endTime, 'endTime');
        override.requiredWorkMinutes = numberOrDefault(req.body.requiredWorkMinutes, override.requiredWorkMinutes);
    } else {
        override.requiredWorkMinutes = 0;
    }
    override.note = req.body.note;
    override.isActive = isActive;
    override.supersededAt = willBeSuperseded;
    const saved = await override.save();
    const populated = await saved.populate([
        { path: 'group', select: 'name isActive' },
        { path: 'employee', select: 'username privilege isActive' },
        { path: 'branch', select: 'name timezone isActive' },
    ]);
    res.status(200).json(populated);
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

export const createScheduleGroup = ok(async (req, res) => {
    requireAdmin(req);
    let branch: Types.ObjectId | undefined;
    if (req.body.branchId !== undefined && req.body.branchId !== null && req.body.branchId !== '') {
        branch = toObjectId(req.body.branchId, 'branchId');
        const branchDoc = await Branch.findById(branch, { _id: 1 }).lean();
        if (!branchDoc) throw new AppError('Branch not found', 404);
    }
    const group = await AttendanceScheduleGroup.create({
        name: req.body.name,
        description: req.body.description,
        ...(branch ? { branch } : {}),
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(await scheduleGroupSummary(group));
});

export const listScheduleGroups = ok(async (req, res) => {
    requireAdminOrManager(req);
    const actorBranchId = await getActorBranchId(req);
    const query = actorBranchId
        ? { branch: { $eq: actorBranchId, $exists: true, $ne: null } }
        : {};
    const groups = await AttendanceScheduleGroup.find(query).sort({ name: 1 });
    const items = await Promise.all(groups.map((group) => scheduleGroupSummary(group)));
    res.status(200).json({ items });
});

export const updateScheduleGroup = ok(async (req, res) => {
    requireAdmin(req);
    const group = await AttendanceScheduleGroup.findById(req.params.id);
    if (!group) throw new AppError('Schedule group not found', 404);
    if (req.body.name !== undefined) group.name = req.body.name;
    if (req.body.description !== undefined) group.description = req.body.description;
    if (req.body.isActive !== undefined) group.isActive = req.body.isActive === true;
    await group.save();
    res.status(200).json(await scheduleGroupSummary(group));
});

async function scheduleGroupMembers(groupId: Types.ObjectId, asOf = new Date(), managementView = true) {
    const memberships = await AttendanceScheduleGroupMembership.find({
        group: groupId,
        ...(managementView
            ? managedGroupMembershipQuery(asOf)
            : effectiveMembershipQuery(asOf)),
    }).populate('employee', 'username isActive privilege').sort({ effectiveFrom: -1 }).lean();
    const employeeIds = memberships.map((membership: any) => membership.employee?._id ?? membership.employee);
    const branches = await branchesForEmployees(employeeIds);
    const items = memberships.map((membership: any) => {
        const employeeId = String(membership.employee?._id ?? membership.employee);
        const branch = branches.find((item) => branchContainsEmployeeOrManager(item, employeeId));
        return {
            membershipId: String(membership._id),
            employeeId,
            employeeName: membership.employee?.username ?? employeeId,
            branchId: branch ? String(branch._id) : undefined,
            branchName: branch?.name,
            effectiveFrom: membership.effectiveFrom,
            effectiveTo: membership.effectiveTo,
            isActive: membership.isActive,
        };
    });
    if (!managementView) return items;

    const latestByEmployee = new Map<string, (typeof items)[number]>();
    for (const item of items) {
        const existing = latestByEmployee.get(item.employeeId);
        if (!existing) {
            latestByEmployee.set(item.employeeId, item);
            continue;
        }
        const existingFrom = new Date(existing.effectiveFrom).getTime();
        const nextFrom = new Date(item.effectiveFrom).getTime();
        if (nextFrom >= existingFrom) {
            latestByEmployee.set(item.employeeId, item);
        }
    }
    return Array.from(latestByEmployee.values()).sort((a, b) =>
        a.employeeName.localeCompare(b.employeeName));
}

export const listScheduleGroupMembers = ok(async (req, res) => {
    requireAdminOrManager(req);
    const groupId = toObjectId(req.params.id, 'id');
    const group = await AttendanceScheduleGroup.findById(groupId).lean();
    if (!group) throw new AppError('Schedule group not found', 404);
    const managementView = req.query.managementView !== 'false';
    res.status(200).json({ items: await scheduleGroupMembers(groupId, new Date(), managementView) });
});

async function scheduleGroupTransferPreview(groupId: Types.ObjectId, employeeIds: Types.ObjectId[]) {
    const existing = await AttendanceScheduleGroupMembership.find({
        group: { $ne: groupId },
        employee: { $in: employeeIds },
        ...effectiveMembershipQuery(new Date()),
    }).populate('group', 'name').populate('employee', 'username').lean();
    return existing.map((membership: any) => ({
        employeeId: String(membership.employee?._id ?? membership.employee),
        employeeName: membership.employee?.username ?? String(membership.employee),
        groupId: String(membership.group?._id ?? membership.group),
        groupName: membership.group?.name ?? 'another group',
    }));
}

export const previewScheduleGroupMembers = ok(async (req, res) => {
    requireAdminOrManager(req);
    const groupId = toObjectId(req.params.id, 'id');
    const group = await AttendanceScheduleGroup.findById(groupId).lean();
    if (!group) throw new AppError('Schedule group not found', 404);
    await assertCanManageGroup(req, group);
    const employeeIds = Array.isArray(req.body.employeeIds)
        ? req.body.employeeIds.map((id: string) => toObjectId(id, 'employeeIds'))
        : [];
    await assertEmployeesMatchGroupBranch(employeeIds, group.branch);
    res.status(200).json({
        transfers: await scheduleGroupTransferPreview(groupId, employeeIds),
    });
});

export const setScheduleGroupMembers = ok(async (req, res) => {
    requireAdminOrManager(req);
    const groupId = toObjectId(req.params.id, 'id');
    const group = await AttendanceScheduleGroup.findById(groupId);
    if (!group || !group.isActive) throw new AppError('Schedule group not found or inactive', 404);
    await assertCanManageGroup(req, group);
    const createdBy = requireUserId(req);
    const employeeIds = Array.isArray(req.body.employeeIds)
        ? (Array.from(new Set(req.body.employeeIds.map(String))) as string[]).map((id) => toObjectId(id, 'employeeIds'))
        : [];
    await assertEmployeesMatchGroupBranch(employeeIds, group.branch);
    const transfers = await scheduleGroupTransferPreview(groupId, employeeIds);
    if (transfers.length > 0 && req.body.confirmTransfer !== true) {
        res.status(409).json({
            message: 'Selected employees already belong to another schedule group',
            transfers,
        });
        return;
    }

    const effectiveFrom = await membershipEffectiveDateForEmployees(groupId, employeeIds);
    const closeImmediately = effectiveFrom.getTime() <= Date.now();
    await AttendanceScheduleGroupMembership.updateMany({
        group: groupId,
        employee: { $nin: employeeIds },
        ...effectiveMembershipQuery(new Date()),
    }, { $set: { effectiveTo: effectiveFrom, isActive: !closeImmediately } });
    await AttendanceScheduleGroupMembership.updateMany({
        group: { $ne: groupId },
        employee: { $in: employeeIds },
        ...effectiveMembershipQuery(new Date()),
    }, { $set: { effectiveTo: effectiveFrom, isActive: !closeImmediately } });

    const existingTargetMemberships = await AttendanceScheduleGroupMembership.find({
        group: groupId,
        employee: { $in: employeeIds },
        ...effectiveMembershipQuery(effectiveFrom),
    }, { employee: 1 }).lean();
    const existingEmployeeIds = new Set(existingTargetMemberships.map((item) => String(item.employee)));
    const toCreate = employeeIds
        .filter((employeeId) => !existingEmployeeIds.has(String(employeeId)))
        .map((employeeId) => ({
            group: groupId,
            employee: employeeId,
            effectiveFrom,
            isActive: true,
            createdBy,
        }));
    if (toCreate.length > 0) {
        await AttendanceScheduleGroupMembership.insertMany(toCreate);
    }

    res.status(200).json({
        group: await scheduleGroupSummary(group),
        members: await scheduleGroupMembers(groupId),
        transfers,
    });
});

export const removeScheduleGroupMember = ok(async (req, res) => {
    requireAdminOrManager(req);
    const groupId = toObjectId(req.params.id, 'id');
    const employeeId = toObjectId(req.params.employeeId, 'employeeId');
    const group = await AttendanceScheduleGroup.findById(groupId);
    if (!group) throw new AppError('Schedule group not found', 404);
    await assertCanManageGroup(req, group);
    const effectiveTo = await membershipEffectiveDateForEmployees(groupId, [employeeId]);
    const closeImmediately = effectiveTo.getTime() <= Date.now();
    const membership = await AttendanceScheduleGroupMembership.findOneAndUpdate({
        group: groupId,
        employee: employeeId,
        ...effectiveMembershipQuery(new Date()),
    }, { $set: { effectiveTo, isActive: !closeImmediately } }, { new: true });
    if (!membership) throw new AppError('Schedule group member not found', 404);
    res.status(200).json({
        removed: true,
        effectiveTo,
        group: await scheduleGroupSummary(group),
        members: await scheduleGroupMembers(groupId),
    });
});

export const createScheduleTemplate = ok(async (req, res) => {
    requireAdminOrManager(req);
    let branch: Types.ObjectId | undefined;
    if (req.privilege === 'manager') {
        branch = await assertManagerBranch(req);
    } else if (req.body.branchId !== undefined && req.body.branchId !== null && req.body.branchId !== '') {
        branch = toObjectId(req.body.branchId, 'branchId');
        const branchDoc = await Branch.findById(branch, { _id: 1 }).lean();
        if (!branchDoc) throw new AppError('Branch not found', 404);
    }
    const template = await AttendanceScheduleTemplate.create({
        name: req.body.name,
        type: 'weekly',
        weeklyPattern: req.body.weeklyPattern,
        branch,
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(serializeScheduleTemplate(template));
});

export const listScheduleTemplates = ok(async (req, res) => {
    requireAdminOrManager(req);
    const actorBranchId = await getActorBranchId(req);
    const query = actorBranchId
        ? { $or: [{ branch: actorBranchId }, { branch: { $exists: false } }, { branch: null }] }
        : {};
    const items = await AttendanceScheduleTemplate.find(query).sort({ name: 1 });
    res.status(200).json({ items: items.map(serializeScheduleTemplate) });
});

export const updateScheduleTemplate = ok(async (req, res) => {
    requireAdminOrManager(req);
    const existing = await AttendanceScheduleTemplate.findById(req.params.id);
    if (!existing) throw new AppError('Schedule template not found', 404);
    await assertCanManageTemplate(req, existing);
    if (req.privilege === 'manager' && req.body.branchId !== undefined) {
        throw new AppError('Managers cannot change template branch scope', 403);
    }
    const template = await AttendanceScheduleTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!template) throw new AppError('Schedule template not found', 404);
    res.status(200).json(serializeScheduleTemplate(template));
});

export const createScheduleAssignment = ok(async (req, res) => {
    requireAdminOrManager(req);
    if (!['global', 'branch', 'group', 'employee'].includes(req.body.targetType)) {
        throw new AppError('targetType must be global, branch, group, or employee', 400);
    }
    await assertManagerAssignmentPayload(req, req.body);
    const template = toObjectId(req.body.templateId, 'templateId');
    const branch = req.body.targetType === 'branch' ? toObjectId(req.body.branchId, 'branchId') : undefined;
    const group = req.body.targetType === 'group' ? toObjectId(req.body.groupId, 'groupId') : undefined;
    const employee = req.body.targetType === 'employee' ? toObjectId(req.body.employeeId, 'employeeId') : undefined;
    const effectiveFrom = parseDate(req.body.effectiveFrom, 'effectiveFrom');
    if (!effectiveFrom) throw new AppError('effectiveFrom is required', 400);
    const filter = req.body.targetType === 'branch'
        ? { targetType: 'branch', branch, isActive: true, supersededAt: { $exists: false } }
        : req.body.targetType === 'group'
            ? { targetType: 'group', group, isActive: true, supersededAt: { $exists: false } }
            : req.body.targetType === 'employee'
                ? { targetType: 'employee', employee, isActive: true, supersededAt: { $exists: false } }
                : { targetType: 'global', isActive: true, supersededAt: { $exists: false } };
    await AttendanceScheduleAssignment.updateMany(filter, { $set: { supersededAt: new Date(), isActive: false } });
    const assignment = await AttendanceScheduleAssignment.create({
        template,
        targetType: req.body.targetType,
        branch,
        group,
        employee,
        effectiveFrom,
        expiresAt: parseDate(req.body.expiresAt, 'expiresAt'),
        isActive: req.body.isActive ?? true,
        createdBy: requireUserId(req),
    });
    res.status(201).json(serializeScheduleAssignment(assignment));
});

export const listScheduleAssignments = ok(async (req, res) => {
    requireAdminOrManager(req);
    const actorBranchId = await getActorBranchId(req);
    if (!actorBranchId) {
        const items = await AttendanceScheduleAssignment.find().sort({ createdAt: -1 });
        res.status(200).json({ items: items.map(serializeScheduleAssignment) });
        return;
    }

    const branchGroups = await AttendanceScheduleGroup.find({
        branch: { $eq: actorBranchId, $exists: true, $ne: null },
    }, { _id: 1 }).lean();
    const groupIds = branchGroups.map((item) => item._id);
    const items = await AttendanceScheduleAssignment.find({
        $or: [
            { targetType: 'branch', branch: actorBranchId },
            { targetType: 'group', group: { $in: groupIds } },
        ],
    }).sort({ createdAt: -1 });
    res.status(200).json({ items: items.map(serializeScheduleAssignment) });
});

export const updateScheduleAssignment = ok(async (req, res) => {
    requireAdminOrManager(req);
    const assignment = await AttendanceScheduleAssignment.findById(req.params.id);
    if (!assignment) throw new AppError('Schedule assignment not found', 404);
    await assertCanManageAssignment(req, assignment);

    if (req.body.templateId !== undefined) {
        assignment.template = toObjectId(req.body.templateId, 'templateId');
    }

    if (req.body.targetType !== undefined) {
        if (!['global', 'branch', 'group', 'employee'].includes(req.body.targetType)) {
            throw new AppError('targetType must be global, branch, group, or employee', 400);
        }
        assignment.targetType = req.body.targetType;
    }

    await assertManagerAssignmentPayload(req, {
        targetType: assignment.targetType,
        branchId: req.body.branchId ?? (assignment.branch ? String(assignment.branch) : undefined),
        groupId: req.body.groupId ?? (assignment.group ? String(assignment.group) : undefined),
    });

    if (req.body.branchId !== undefined) {
        assignment.branch = req.body.branchId === null || req.body.branchId === ''
            ? undefined
            : toObjectId(req.body.branchId, 'branchId');
    } else if (assignment.targetType !== 'branch') {
        assignment.branch = undefined;
    }

    if (req.body.groupId !== undefined) {
        assignment.group = req.body.groupId === null || req.body.groupId === ''
            ? undefined
            : toObjectId(req.body.groupId, 'groupId');
    } else if (assignment.targetType !== 'group') {
        assignment.group = undefined;
    }

    if (req.body.employeeId !== undefined) {
        assignment.employee = req.body.employeeId === null || req.body.employeeId === ''
            ? undefined
            : toObjectId(req.body.employeeId, 'employeeId');
    } else if (assignment.targetType !== 'employee') {
        assignment.employee = undefined;
    }

    if (req.body.effectiveFrom !== undefined) {
        const effectiveFrom = parseDate(req.body.effectiveFrom, 'effectiveFrom');
        if (!effectiveFrom) throw new AppError('effectiveFrom is required', 400);
        assignment.effectiveFrom = effectiveFrom;
    }

    if (req.body.expiresAt !== undefined) {
        assignment.expiresAt = parseDate(req.body.expiresAt, 'expiresAt');
    }

    if (req.body.supersededAt !== undefined) {
        assignment.supersededAt = parseDate(req.body.supersededAt, 'supersededAt');
    }

    if (req.body.isActive !== undefined) {
        assignment.isActive = req.body.isActive === true;
        if (!assignment.isActive) {
            assignment.supersededAt = new Date();
        }
    }

    const updated = await assignment.save();
    res.status(200).json(serializeScheduleAssignment(updated));
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

export const getMyAttendanceStatus = ok(async (req, res) => {
    const employeeId = requireUserId(req);
    const branch = await getEmployeeBranch(employeeId);
    const date = String(req.query.date ?? branchLocalParts(new Date(), branch.timezone).date);
    assertDate(date, 'date');

    if (shouldBypassAttendanceGate(branch)) {
        res.status(200).json({
            date,
            schedule: null,
            branchLocation: branch.location?.latitude !== undefined && branch.location?.longitude !== undefined
                ? {
                    latitude: branch.location.latitude,
                    longitude: branch.location.longitude,
                    allowedRadiusMeters: attendanceLocationRadiusMeters,
                }
                : null,
            snapshot: null,
            workStatus: 'checked_out',
            canCheckIn: false,
            canStartBreak: false,
            canEndBreak: false,
            canCheckOut: false,
            workedMinutes: 0,
            breakOptions: [],
            activeBreak: null,
            attendanceGateBypassed: true,
        });
        return;
    }

    const schedule = await resolveSchedule(employeeId, branch._id, date);
    const events = await getDayEvents(employeeId, date);
    const snapshot = await AttendanceDailySnapshot.findOne({ employee: employeeId, date })
        .populate('employee', 'username')
        .populate('branch', 'name')
        .lean();
    const { firstCheckIn, lastCheckOut, openBreak, breakPairs } = splitAttendanceEvents(events);
    const workingSchedule = hasWorkingSchedule(schedule);
    let workStatus: MyAttendanceWorkStatus;

    if (openBreak) {
        workStatus = 'on_break';
    } else if (lastCheckOut) {
        workStatus = 'checked_out';
    } else if (firstCheckIn) {
        workStatus = 'checked_in';
    } else if (!workingSchedule) {
        workStatus = 'no_schedule';
    } else {
        workStatus = 'not_started';
    }

    let workedMinutes = snapshot?.productiveWorkMinutes ?? 0;
    if (firstCheckIn && !lastCheckOut) {
        const now = new Date();
        const grossMinutes = minutesBetween(firstCheckIn.timestamp, now);
        const completedBreakMinutes = breakPairs.reduce(
            (sum, pair) => sum + minutesBetween(pair.start.timestamp, pair.end.timestamp),
            0
        );
        const openBreakMinutes = openBreak ? minutesBetween(openBreak.timestamp, now) : 0;
        workedMinutes = Math.max(0, grossMinutes - completedBreakMinutes - openBreakMinutes);
    }
    const breakOptions = workStatus === 'checked_in'
        ? await resolveStartableBreakOptions(employeeId, schedule.branchTimezone)
        : [];

    res.status(200).json({
        date,
        schedule: {
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
        },
        branchLocation: branch.location?.latitude !== undefined && branch.location?.longitude !== undefined
            ? {
                latitude: branch.location.latitude,
                longitude: branch.location.longitude,
                allowedRadiusMeters: attendanceLocationRadiusMeters,
            }
            : null,
        snapshot: snapshot ? serializeDailySnapshot(snapshot) : null,
        workStatus,
        canCheckIn: workStatus === 'not_started' && workingSchedule,
        canStartBreak: workStatus === 'checked_in',
        canEndBreak: workStatus === 'on_break',
        canCheckOut: workStatus === 'checked_in',
        workedMinutes,
        breakOptions,
        activeBreak: openBreak
            ? {
                eventId: openBreak._id,
                breakTypeId: openBreak.breakType,
                breakSubtypeId: openBreak.breakSubtype,
                startedAt: openBreak.timestamp,
                branchLocalDate: openBreak.branchLocalDate,
                branchLocalTime: openBreak.branchLocalTime,
            }
            : null,
    });
});

async function createAttendanceEvent(req: Request, type: 'check_in' | 'check_out' | 'break_start' | 'break_end') {
    const employeeId = requireUserId(req);
    const branch = await getEmployeeBranch(employeeId);
    const isAdminAttendance = req.privilege === 'admin';
    let locationProof: AttendanceLocationProof | undefined;
    if (!isAdminAttendance) {
        const user = await User.findById(employeeId)
            .select('profileImageFile +faceEmbedding')
            .lean();
        if (!user?.profileImageFile || !hasFaceEnrollment(user)) {
            throw new AppError('Profile photo and face enrollment are required for attendance', 400);
        }
        locationProof = buildAttendanceLocationProof(req, branch);
    }
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
    if (type === 'check_in') {
        const schedule = await resolveSchedule(employeeId, branch._id, local.date);
        if (!hasWorkingSchedule(schedule)) {
            throw new AppError('No attendance schedule is available for today', 400);
        }
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
            if (!isWithinWindow(nowMinutes, subtype.windowStart, subtype.windowEnd)) {
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
        location: locationProof,
        notes: req.body.notes,
    });
}

export const checkIn = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'check_in');
    await generateDailySnapshotFromEvent(event);
    res.status(201).json(event);
});

export const breakStart = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'break_start');
    await generateDailySnapshotFromEvent(event);
    res.status(201).json(event);
});

export const breakEnd = ok(async (req, res) => {
    const event = await createAttendanceEvent(req, 'break_end');
    await generateDailySnapshotFromEvent(event);
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
    const items = await AttendanceDailySnapshot.find(query)
        .populate('employee', 'username')
        .populate('branch', 'name')
        .sort({ date: -1 })
        .lean();
    res.status(200).json({ items: serializeDailySnapshots(items) });
});

export const getEmployeeDailySnapshots = ok(async (req, res) => {
    await assertManagerCanViewEmployee(req, req.params.employeeId);
    const query: Record<string, unknown> = { employee: toObjectId(req.params.employeeId, 'employeeId') };
    if (req.query.date) query.date = String(req.query.date);
    const items = await AttendanceDailySnapshot.find(query)
        .populate('employee', 'username')
        .populate('branch', 'name')
        .sort({ date: -1 })
        .lean();
    res.status(200).json({ items: serializeDailySnapshots(items) });
});

export const getTeamDailySnapshots = ok(async (req, res) => {
    if (req.privilege === 'staff') throw new AppError('Not authorized', 403);
    const query: Record<string, unknown> = {};
    if (req.query.date) query.date = String(req.query.date);
    if (req.privilege === 'manager') {
        const staffIds = await User.find({ manager: req.userId }, { _id: 1 }).lean();
        query.employee = { $in: staffIds.map((staff) => staff._id) };
    }
    const items = await AttendanceDailySnapshot.find(query)
        .populate('employee', 'username')
        .populate('branch', 'name')
        .sort({ date: -1 })
        .lean();
    res.status(200).json({ items: serializeDailySnapshots(items) });
});

export const getTeamAttendanceAttention = ok(async (req, res) => {
    if (req.privilege === 'staff') throw new AppError('Not authorized', 403);
    const now = new Date();
    const beforeDate = req.query.beforeDate ? String(req.query.beforeDate) : undefined;
    if (beforeDate) assertDate(beforeDate, 'beforeDate');
    const rangeEnd = beforeDate ?? now.toISOString().slice(0, 10);
    const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 90);
    const startDate = new Date(`${rangeEnd}T00:00:00.000Z`);
    startDate.setUTCDate(startDate.getUTCDate() - days);
    const fromDate = startDate.toISOString().slice(0, 10);
    const query: Record<string, unknown> = {
        date: beforeDate ? { $gte: fromDate, $lt: beforeDate } : { $gte: fromDate },
        $or: [
            { status: { $in: ['open_break', 'missing_checkout'] } },
            {
                status: 'incomplete',
                firstCheckIn: { $exists: true },
                $or: [{ lastCheckOut: { $exists: false } }, { lastCheckOut: null }, { lastCheckOut: '' }],
            },
        ],
    };
    if (req.privilege === 'manager') {
        const staffIds = await User.find({ manager: req.userId }, { _id: 1 }).lean();
        query.employee = { $in: staffIds.map((staff) => staff._id) };
    }
    const snapshots = await AttendanceDailySnapshot.find(query)
        .populate('employee', 'username')
        .populate('branch', 'name')
        .sort({ date: -1, updatedAt: -1 })
        .lean();
    const items = beforeDate
        ? snapshots
        : snapshots.filter((snapshot) => snapshot.date < branchLocalParts(now, snapshot.branchTimezone).date);
    res.status(200).json({ items: serializeDailySnapshots(items) });
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
    if (typeof req.body.reason !== 'string' || req.body.reason.trim().length === 0) {
        throw new AppError('reason is required', 400);
    }
    assertTime(req.body.checkoutTime, 'checkoutTime');
    const events = await getDayEvents(snapshot.employee, snapshot.date);
    if (latestOpenBreakStart(events)) {
        throw new AppError('Close the open break before correcting checkout', 409);
    }
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
        notes: req.body.reason.trim(),
        recalculateBasis: req.body.recalculateBasis === true,
    });
    res.status(200).json({ snapshot: regenerated });
});

export const correctBreakEnd = ok(async (req, res) => {
    requireAdmin(req);
    const snapshot = await AttendanceDailySnapshot.findById(req.params.id);
    if (!snapshot) throw new AppError('Daily snapshot not found', 404);
    if (typeof req.body.reason !== 'string' || req.body.reason.trim().length === 0) {
        throw new AppError('reason is required', 400);
    }
    assertTime(req.body.breakEndTime, 'breakEndTime');
    const events = await getDayEvents(snapshot.employee, snapshot.date);
    const openBreakStart = latestOpenBreakStart(events);
    if (!openBreakStart) {
        throw new AppError('No open break found for this snapshot', 409);
    }
    const timestamp = branchLocalDateTimeToUtc(snapshot.date, req.body.breakEndTime, snapshot.branchTimezone);
    if (timestamp <= openBreakStart.timestamp) {
        throw new AppError('breakEndTime must be after the open break start', 400);
    }
    const local = branchLocalParts(timestamp, snapshot.branchTimezone);
    await AttendanceEvent.create({
        employee: snapshot.employee,
        branch: snapshot.branch,
        type: 'break_end',
        timestamp,
        branchLocalDate: snapshot.date,
        branchLocalTime: local.time,
        branchTimezone: snapshot.branchTimezone,
        breakType: openBreakStart.breakType,
        breakSubtype: openBreakStart.breakSubtype,
        source: 'admin',
        createdBy: requireUserId(req),
        notes: req.body.reason,
    });
    const regenerated = await generateDailySnapshot({
        employeeId: snapshot.employee,
        branchId: snapshot.branch,
        dateString: snapshot.date,
        generatedBy: 'correction',
        notes: req.body.reason.trim(),
        recalculateBasis: req.body.recalculateBasis === true,
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
