import 'dotenv/config';
import mongoose, { ClientSession, Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import User from '../models/User';
import AttendanceShift from '../models/AttendanceShift';
import AttendanceScheduleTemplate, {
    AttendanceScheduleAssignment,
    AttendanceScheduleGroup,
    AttendanceScheduleGroupMembership,
} from '../models/AttendanceSchedule';

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

type ShiftSpec = {
    startTime: string;
    endTime: string;
};

type BranchScheduleSpec = {
    branchName: string;
    shifts: ShiftSpec[];
    groupNames?: Array<{ canonical: string; aliases?: string[] }>;
};

type Args = {
    apply: boolean;
    effectiveDate: string;
    effectiveFrom: Date;
};

type PlannedTarget = {
    targetType: 'branch' | 'group';
    targetId: Types.ObjectId;
    targetName: string;
    branchId: Types.ObjectId;
    branchName: string;
    shift: ShiftSpec & { requiredWorkMinutes: number };
    templateName: string;
};

const configuration: BranchScheduleSpec[] = [
    { branchName: 'ISTORE KANNUR', shifts: [{ startTime: '11:00', endTime: '22:00' }] },
    {
        branchName: 'ISTORE IRITTY',
        shifts: [{ startTime: '09:30', endTime: '21:00' }, { startTime: '10:30', endTime: '22:00' }],
        groupNames: [{ canonical: 'Iritty Group 1', aliases: ['Iritty 1'] }, { canonical: 'Iritty Group 2', aliases: ['Iritty 2'] }],
    },
    {
        branchName: 'ISTORE MATTANNUR',
        shifts: [{ startTime: '09:30', endTime: '21:00' }, { startTime: '10:30', endTime: '22:00' }],
        groupNames: [{ canonical: 'Mattannur Group 1', aliases: ['Mattannur Team 1'] }, { canonical: 'Mattannur Group 2', aliases: ['Mattannur Team 2'] }],
    },
    { branchName: 'ISTORE TALIPARAMBA', shifts: [{ startTime: '10:00', endTime: '22:00' }] },
    { branchName: '19TH MILE', shifts: [{ startTime: '09:30', endTime: '22:00' }] },
    {
        branchName: 'ISTORE PAYYANNUR',
        shifts: [{ startTime: '09:30', endTime: '21:00' }, { startTime: '10:30', endTime: '22:00' }],
        groupNames: [{ canonical: 'Payyannur Group 1', aliases: ['Payyannur 1'] }, { canonical: 'Payyannur Group 2', aliases: ['Payyannur 2'] }],
    },
    { branchName: 'CERTIVO', shifts: [{ startTime: '10:00', endTime: '21:00' }] },
    {
        branchName: 'KANNUR HEAD OFFICE',
        shifts: [{ startTime: '09:30', endTime: '17:30' }, { startTime: '09:30', endTime: '19:00' }],
        groupNames: [{ canonical: 'Head Office Group 1' }, { canonical: 'Head Office Group 2' }],
    },
    { branchName: 'ACCOUNTS', shifts: [{ startTime: '10:00', endTime: '18:00' }] },
];

const retiredGroupNames = ['test', 'test-2'];

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const effectiveFromValue = argv.find((value) => value.startsWith('--effective-from='))?.split('=')[1];
    if (!effectiveFromValue || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFromValue)) {
        throw new Error('Usage: npm run configure:branch-attendance -- --effective-from=YYYY-MM-DD [--dry-run|--apply]');
    }
    const effectiveFrom = new Date(`${effectiveFromValue}T00:00:00.000+05:30`);
    if (Number.isNaN(effectiveFrom.getTime())) throw new Error('Invalid --effective-from date');
    if (effectiveFrom.getTime() <= Date.now()) throw new Error('--effective-from must be a future Asia/Kolkata calendar day');
    return { apply: argv.includes('--apply'), effectiveDate: effectiveFromValue, effectiveFrom };
}

function minutesBetween(startTime: string, endTime: string) {
    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);
    let windowMinutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
    if (windowMinutes <= 0) windowMinutes += 24 * 60;
    return windowMinutes;
}

function requiredWorkMinutes(shift: ShiftSpec) {
    return Math.max(0, minutesBetween(shift.startTime, shift.endTime) - 60);
}

function displayTime(time: string) {
    const [hourValue, minute] = time.split(':').map(Number);
    const suffix = hourValue >= 12 ? 'PM' : 'AM';
    const hour = hourValue % 12 || 12;
    return `${hour}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${suffix}`;
}

function shiftName(shift: ShiftSpec) {
    return `${displayTime(shift.startTime)} to ${displayTime(shift.endTime)}`;
}

function weeklyPattern(shiftId: Types.ObjectId) {
    return Object.fromEntries(weekdays.map((weekday) => [weekday, [shiftId]]));
}

async function resolvePlan() {
    const errors: string[] = [];
    const warnings: string[] = [];
    const targets: PlannedTarget[] = [];
    const branches = await Branch.find({ name: { $in: configuration.map((item) => item.branchName) } }).lean();

    for (const spec of configuration) {
        const branch = branches.find((item) => item.name === spec.branchName);
        if (!branch) {
            errors.push(`Missing branch: ${spec.branchName}`);
            continue;
        }
        if (!branch.isActive) errors.push(`Branch is inactive: ${spec.branchName}`);

        const defaultShift = { ...spec.shifts[0], requiredWorkMinutes: requiredWorkMinutes(spec.shifts[0]) };
        targets.push({
            targetType: 'branch',
            targetId: branch._id,
            targetName: branch.name,
            branchId: branch._id,
            branchName: branch.name,
            shift: defaultShift,
            templateName: `${branch.name} Default Schedule`,
        });

        if (!spec.groupNames) continue;
        for (let index = 0; index < spec.groupNames.length; index += 1) {
            const groupSpec = spec.groupNames[index];
            const acceptedNames = [groupSpec.canonical, ...(groupSpec.aliases ?? [])];
            let group = await AttendanceScheduleGroup.findOne({ name: { $in: acceptedNames } });
            if (group && group.branch && String(group.branch) !== String(branch._id)) {
                errors.push(`Group ${group.name} belongs to another branch instead of ${branch.name}`);
                continue;
            }
            const groupShiftSpec = spec.shifts[Math.min(index, spec.shifts.length - 1)];
            if (!group) {
                warnings.push(`Will create empty group ${groupSpec.canonical}; add members before its override is useful`);
                group = new AttendanceScheduleGroup({
                    name: groupSpec.canonical,
                    branch: branch._id,
                    isActive: true,
                    createdBy: new Types.ObjectId(),
                });
            }
            targets.push({
                targetType: 'group',
                targetId: group._id,
                targetName: groupSpec.canonical,
                branchId: branch._id,
                branchName: branch.name,
                shift: { ...groupShiftSpec, requiredWorkMinutes: requiredWorkMinutes(groupShiftSpec) },
                templateName: `${groupSpec.canonical} Schedule`,
            });
        }
    }

    return { errors, warnings, targets };
}

async function upsertShift(target: PlannedTarget, actorId: Types.ObjectId, session: ClientSession) {
    const canonicalName = shiftName(target.shift);
    const query = {
        startTime: target.shift.startTime,
        endTime: target.shift.endTime,
        requiredWorkMinutes: target.shift.requiredWorkMinutes,
        isActive: true,
    };
    let shift = await AttendanceShift.findOne(query).session(session);
    if (!shift) {
        shift = await AttendanceShift.create([{
            name: canonicalName,
            ...target.shift,
            weeklyPattern: Object.fromEntries(weekdays.map((weekday) => [weekday, null])),
            branchIds: [target.branchId],
            version: 1,
            graceLateMinutes: 0,
            graceEarlyLeaveMinutes: 0,
            isActive: true,
            createdBy: actorId,
        }], { session }).then((items) => items[0]);
    } else {
        let changed = false;
        if (shift.name !== canonicalName) {
            shift.previousVersions.push({
                version: shift.version,
                name: shift.name,
                startTime: shift.startTime,
                endTime: shift.endTime,
                requiredWorkMinutes: shift.requiredWorkMinutes,
                weeklyPattern: shift.weeklyPattern,
                graceLateMinutes: shift.graceLateMinutes,
                graceEarlyLeaveMinutes: shift.graceEarlyLeaveMinutes,
                isActive: shift.isActive,
                savedAt: new Date(),
            });
            shift.name = canonicalName;
            shift.version += 1;
            changed = true;
        }
        if (!(shift.branchIds ?? []).some((id) => String(id) === String(target.branchId))) {
            shift.branchIds = [...(shift.branchIds ?? []), target.branchId];
            changed = true;
        }
        if (changed) await shift.save({ session });
    }
    return shift;
}

async function resolveOrCreateGroup(target: PlannedTarget, actorId: Types.ObjectId, session: ClientSession) {
    if (target.targetType !== 'group') return target.targetId;
    const spec = configuration
        .find((item) => item.branchName === target.branchName)
        ?.groupNames?.find((item) => item.canonical === target.targetName);
    const names = [target.targetName, ...(spec?.aliases ?? [])];
    let group = await AttendanceScheduleGroup.findOne({ name: { $in: names } }).session(session);
    if (!group) {
        group = await AttendanceScheduleGroup.create([{
            name: target.targetName,
            branch: target.branchId,
            isActive: true,
            createdBy: actorId,
        }], { session }).then((items) => items[0]);
    } else {
        group.name = target.targetName;
        group.branch = target.branchId;
        group.isActive = true;
        await group.save({ session });
    }
    if (!group) throw new Error(`Failed to create schedule group ${target.targetName}`);
    return group._id;
}

async function applyConfiguration(plan: Awaited<ReturnType<typeof resolvePlan>>, args: Args) {
    const actor = await User.findOne({ privilege: 'admin', isActive: true, isAccountDeleted: { $ne: true } }, { _id: 1 }).lean();
    if (!actor) throw new Error('No active admin user is available as migration actor');

    const work = async (session?: ClientSession) => {
        for (const target of plan.targets) {
            const targetId = await resolveOrCreateGroup(target, actor._id, session!);
            const shift = await upsertShift(target, actor._id, session!);
            if (!shift) throw new Error(`Failed to create shift for ${target.targetName}`);
            let template = await AttendanceScheduleTemplate.findOne({ name: target.templateName }).session(session ?? null);
            if (!template) {
                template = await AttendanceScheduleTemplate.create([{
                    name: target.templateName,
                    type: 'weekly',
                    weeklyPattern: weeklyPattern(shift._id),
                    branch: target.branchId,
                    isActive: true,
                    createdBy: actor._id,
                }], session ? { session } : undefined).then((items) => items[0]);
            } else {
                template.weeklyPattern = weeklyPattern(shift._id) as any;
                template.branch = target.branchId;
                template.isActive = true;
                await template.save(session ? { session } : undefined);
            }
            if (!template) throw new Error(`Failed to create template ${target.templateName}`);

            const targetFilter = target.targetType === 'branch'
                ? { targetType: 'branch', branch: targetId }
                : { targetType: 'group', group: targetId };
            const upcoming = await AttendanceScheduleAssignment.find({
                ...targetFilter,
                configurationStatus: 'upcoming',
                supersededAt: { $exists: false },
                effectiveFrom: { $gt: new Date() },
            }).session(session ?? null);
            const sameUpcoming = upcoming.find((item) =>
                String(item.template) === String(template!._id) &&
                item.effectiveFrom.getTime() === args.effectiveFrom.getTime());
            if (sameUpcoming && upcoming.length === 1) continue;
            if (upcoming.length > 0) {
                await AttendanceScheduleAssignment.updateMany(
                    { _id: { $in: upcoming.map((item) => item._id) } },
                    { $set: { isActive: false, supersededAt: new Date() } },
                    session ? { session } : undefined,
                );
            }
            const current = await AttendanceScheduleAssignment.findOne({
                ...targetFilter,
                supersededAt: { $exists: false },
                effectiveFrom: { $lte: new Date() },
                $and: [
                    { $or: [{ isActive: true }, { configurationStatus: 'upcoming' }] },
                    { $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
                ],
            }).sort({ effectiveFrom: -1 }).session(session ?? null);
            if (current) {
                current.expiresAt = args.effectiveFrom;
                await current.save(session ? { session } : undefined);
            }
            await AttendanceScheduleAssignment.create([{
                template: template._id,
                ...targetFilter,
                effectiveFrom: args.effectiveFrom,
                isActive: false,
                configurationStatus: 'upcoming',
                createdBy: actor._id,
            }], session ? { session } : undefined);
        }

        const retiredGroups = await AttendanceScheduleGroup.find({ name: { $in: retiredGroupNames } })
            .session(session ?? null);
        for (const group of retiredGroups) {
            const upcoming = await AttendanceScheduleAssignment.find({
                targetType: 'group',
                group: group._id,
                configurationStatus: 'upcoming',
                supersededAt: { $exists: false },
            }).session(session ?? null);
            if (upcoming.length > 0) {
                await AttendanceScheduleAssignment.updateMany(
                    { _id: { $in: upcoming.map((item) => item._id) } },
                    { $set: { isActive: false, supersededAt: new Date() } },
                    session ? { session } : undefined,
                );
            }
            await AttendanceScheduleAssignment.updateMany({
                targetType: 'group',
                group: group._id,
                supersededAt: { $exists: false },
                effectiveFrom: { $lt: args.effectiveFrom },
                $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: args.effectiveFrom } }],
            }, { $set: { expiresAt: args.effectiveFrom } }, session ? { session } : undefined);
            await AttendanceScheduleGroupMembership.updateMany({
                group: group._id,
                isActive: true,
                $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: null }, { effectiveTo: { $gt: args.effectiveFrom } }],
            }, { $set: { effectiveTo: args.effectiveFrom } }, session ? { session } : undefined);
            group.isActive = false;
            await group.save(session ? { session } : undefined);
        }
    };
    const topology = (mongoose.connection.getClient() as any).topology?.description?.type;
    if (['ReplicaSetWithPrimary', 'Sharded'].includes(topology)) {
        await mongoose.connection.transaction(async (session) => work(session));
    } else {
        await work();
    }
}

export async function configureBranchAttendanceSchedules(args: Args) {
    const plan = await resolvePlan();
    const summary = {
        mode: args.apply ? 'apply' : 'dry-run',
        effectiveFrom: args.effectiveDate,
        targets: plan.targets.map((target) => ({
            branch: target.branchName,
            targetType: target.targetType,
            target: target.targetName,
            shift: `${target.shift.startTime}-${target.shift.endTime}`,
            requiredWorkMinutes: target.shift.requiredWorkMinutes,
            template: target.templateName,
        })),
        warnings: plan.warnings,
        retiredGroups: retiredGroupNames,
        errors: plan.errors,
    };
    if (!args.apply) return summary;
    if (plan.errors.length > 0) throw new Error(`Configuration stopped with ${plan.errors.length} error(s)`);
    await applyConfiguration(plan, args);
    return summary;
}

async function run() {
    const args = parseArgs();
    await connectDb();
    const result = await configureBranchAttendanceSchedules(args);
    console.log(JSON.stringify(result, null, 2));
    await mongoose.connection.close();
}

if (require.main === module) {
    run().catch(async (error) => {
        console.error(error);
        try { await mongoose.connection.close(); } catch {}
        process.exit(1);
    });
}
