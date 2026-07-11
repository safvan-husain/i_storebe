import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose, { Types } from 'mongoose';
import connectDb from '../config/db';
import Branch from '../models/Branch';
import AttendanceShift from '../models/AttendanceShift';
import AttendanceScheduleTemplate, {
    AttendanceScheduleAssignment,
    AttendanceScheduleGroup,
    AttendanceScheduleGroupMembership,
} from '../models/AttendanceSchedule';

type Args = { apply: boolean; backupPath?: string };
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const backupFlag = args.find((value) => value.startsWith('--backup='));
    return {
        apply: args.includes('--apply'),
        backupPath: backupFlag?.slice('--backup='.length),
    };
}

function branchContainsEmployee(branch: any, employeeId: Types.ObjectId) {
    return String(branch.manager ?? '') === String(employeeId) ||
        (branch.staffs ?? []).some((id: Types.ObjectId) => String(id) === String(employeeId));
}

function shiftIdsForTemplate(template: any) {
    return Array.from(new Set(weekdays.flatMap((day) =>
        ((template.weeklyPattern as any)?.[day] ?? []).map(String)
    )));
}

async function captureBackup(filePath: string) {
    const [shifts, groups, memberships, templates, assignments] = await Promise.all([
        AttendanceShift.find().lean(),
        AttendanceScheduleGroup.find().lean(),
        AttendanceScheduleGroupMembership.find().lean(),
        AttendanceScheduleTemplate.find().lean(),
        AttendanceScheduleAssignment.find().lean(),
    ]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
        createdAt: new Date().toISOString(),
        database: mongoose.connection.name,
        collections: { shifts, groups, memberships, templates, assignments },
    }, null, 2));
}

export async function inventoryAttendanceConfiguration() {
    const now = new Date();
    const [branches, shifts, groups, memberships, templates, assignments] = await Promise.all([
        Branch.find({ isActive: true }).lean(),
        AttendanceShift.find({ isActive: true }).lean(),
        AttendanceScheduleGroup.find().lean(),
        AttendanceScheduleGroupMembership.find({
            isActive: true,
            $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: null }, { effectiveTo: { $gt: now } }],
        }).lean(),
        AttendanceScheduleTemplate.find({ isActive: true }).lean(),
        AttendanceScheduleAssignment.find({
            isActive: true,
            supersededAt: { $exists: false },
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
        }).lean(),
    ]);
    const branchById = new Map(branches.map((item) => [String(item._id), item]));
    const groupById = new Map(groups.map((item) => [String(item._id), item]));
    const templateById = new Map(templates.map((item) => [String(item._id), item]));
    const coverage = new Map<string, Set<string>>();
    const errors: string[] = [];

    for (const assignment of assignments) {
        const template = templateById.get(String(assignment.template));
        if (!template) {
            errors.push(`Assignment ${assignment._id} references a missing or inactive template`);
            continue;
        }
        let branchId: string | undefined;
        if (assignment.targetType === 'branch') branchId = String(assignment.branch ?? '');
        if (assignment.targetType === 'group') branchId = String(groupById.get(String(assignment.group))?.branch ?? '');
        if (assignment.targetType === 'employee' && assignment.employee) {
            const matches = branches.filter((branch) => branchContainsEmployee(branch, assignment.employee!));
            if (matches.length === 1) branchId = String(matches[0]._id);
        }
        if (!branchId || !branchById.has(branchId)) {
            errors.push(`Assignment ${assignment._id} has ambiguous branch coverage (${assignment.targetType})`);
            continue;
        }
        for (const shiftId of shiftIdsForTemplate(template)) {
            if (!coverage.has(shiftId)) coverage.set(shiftId, new Set());
            coverage.get(shiftId)!.add(branchId);
        }
    }

    const shiftUpdates: Array<{ shiftId: string; branchIds: string[] }> = [];
    for (const shift of shifts) {
        const stored = (shift.branchIds ?? []).map(String).filter((id) => branchById.has(id));
        const used = Array.from(coverage.get(String(shift._id)) ?? []);
        const branchIds = Array.from(new Set([...stored, ...used]));
        if (branchIds.length === 0) {
            errors.push(`Shift ${shift._id} (${shift.name}) has no unambiguous active branch usage`);
        } else {
            shiftUpdates.push({ shiftId: String(shift._id), branchIds });
        }
    }

    const groupUpdates: Array<{ groupId: string; branchId: string }> = [];
    for (const group of groups) {
        const memberIds = memberships
            .filter((membership) => String(membership.group) === String(group._id))
            .map((membership) => membership.employee);
        const memberBranchIds = new Set<string>();
        for (const employeeId of memberIds) {
            for (const branch of branches) {
                if (branchContainsEmployee(branch, employeeId)) memberBranchIds.add(String(branch._id));
            }
        }
        const storedBranchId = group.branch ? String(group.branch) : undefined;
        if (storedBranchId && !branchById.has(storedBranchId)) {
            errors.push(`Group ${group._id} (${group.name}) references an inactive or missing branch`);
            continue;
        }
        if (memberBranchIds.size > 1 || (storedBranchId && memberBranchIds.size === 1 && !memberBranchIds.has(storedBranchId))) {
            errors.push(`Group ${group._id} (${group.name}) has cross-branch members`);
            continue;
        }
        const branchId = storedBranchId ?? Array.from(memberBranchIds)[0];
        if (!branchId) {
            errors.push(`Group ${group._id} (${group.name}) is branchless and has no members to resolve it`);
            continue;
        }
        groupUpdates.push({ groupId: String(group._id), branchId });
    }

    for (const template of templates) {
        const usedBy = assignments.filter((item) => String(item.template) === String(template._id));
        for (const assignment of usedBy) {
            const branchId = assignment.targetType === 'branch'
                ? String(assignment.branch ?? '')
                : assignment.targetType === 'group'
                    ? String(groupById.get(String(assignment.group))?.branch ?? '')
                    : undefined;
            if (!branchId) continue;
            for (const shiftId of shiftIdsForTemplate(template)) {
                const update = shiftUpdates.find((item) => item.shiftId === shiftId);
                if (!update?.branchIds.includes(branchId)) {
                    errors.push(`Template ${template._id} uses shift ${shiftId} outside branch ${branchId}`);
                }
            }
        }
    }

    return {
        counts: {
            activeBranches: branches.length,
            activeShifts: shifts.length,
            groups: groups.length,
            activeTemplates: templates.length,
            currentOrUpcomingAssignments: assignments.length,
        },
        shiftUpdates,
        groupUpdates,
        errors: Array.from(new Set(errors)),
    };
}

export async function migrateAttendanceConfiguration(args: Args) {
    const inventory = await inventoryAttendanceConfiguration();
    if (!args.apply) return { mode: 'dry-run', ...inventory };
    if (inventory.errors.length > 0) {
        throw new Error(`Migration stopped with ${inventory.errors.length} ambiguous configuration issue(s). Run without --apply for details.`);
    }
    const backupPath = args.backupPath ?? path.resolve(
        process.cwd(),
        'migrations/backups',
        `attendance-configuration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await captureBackup(backupPath);
    await mongoose.connection.transaction(async (session) => {
        for (const update of inventory.shiftUpdates) {
            await AttendanceShift.updateOne(
                { _id: update.shiftId },
                { $set: { branchIds: update.branchIds.map((id) => new Types.ObjectId(id)) } },
                { session },
            );
        }
        for (const update of inventory.groupUpdates) {
            await AttendanceScheduleGroup.updateOne(
                { _id: update.groupId },
                { $set: { branch: new Types.ObjectId(update.branchId) } },
                { session },
            );
        }
    });
    return { mode: 'apply', backupPath, ...inventory };
}

async function run() {
    const args = parseArgs();
    await connectDb();
    const result = await migrateAttendanceConfiguration(args);
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
