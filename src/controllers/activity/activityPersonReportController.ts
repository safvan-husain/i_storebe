import { Request } from 'express';
import { Types } from 'mongoose';
import Activity from '../../models/Activity';
import Branch from '../../models/Branch';
import BranchMembership, { IBranchMembership } from '../../models/BranchMembership';
import Lead from '../../models/Lead';
import User from '../../models/User';
import { TypedResponse } from '../../common/interface';
import { AppError, onCatchError } from '../../middleware/error';
import { runtimeValidation } from '../../utils/validation';
import { createPdf } from '../../utils/pdf';
import { personReportRequestSchema, statsSchema } from './validation';
import {
    PersonActivityReportRow,
    buildPerUserMetrics,
    emptyMetrics,
    formatRoleLabel,
    formatStintDate,
    generatePersonActivityReportHtml,
    sumActivityReportMetrics,
    uniqueObjectIds,
} from './activityReportShared';

type PersonStint = {
    branchId: Types.ObjectId;
    branchName: string;
    role: IBranchMembership['role'];
    membership: IBranchMembership | null;
    stintStart: Date;
    stintEnd: Date;
};

const clipStintRange = (
    membershipStart: Date,
    membershipEnd: Date | undefined,
    rangeStart: Date,
    rangeEnd: Date,
) => {
    const stintStart = membershipStart > rangeStart ? membershipStart : rangeStart;
    const stintEnd = membershipEnd && membershipEnd < rangeEnd ? membershipEnd : rangeEnd;
    return { stintStart, stintEnd };
};

const resolvePersonStints = async (
    userId: Types.ObjectId,
    rangeStart: Date,
    rangeEnd: Date,
    createdAt: { $gte: Date; $lte: Date } | undefined,
): Promise<PersonStint[]> => {
    const memberships = await BranchMembership.find({
        user: userId,
        startedAt: { $lte: rangeEnd },
        $or: [
            { endedAt: { $exists: false } },
            { endedAt: { $gte: rangeStart } },
        ],
    }).sort({ startedAt: 1 }).lean();

    const branchIds = uniqueObjectIds(memberships.map(item => item.branch));
    const activityBranchIds = await Activity.distinct('actorBranch', {
        activator: userId,
        actorBranch: { $exists: true },
        ...(createdAt ? { createdAt } : { createdAt: { $gte: rangeStart, $lte: rangeEnd } }),
    });
    const leadBranchIds = await Lead.distinct('createdBranch', {
        createdBy: userId,
        createdBranch: { $exists: true },
        ...(createdAt ? { createdAt } : { createdAt: { $gte: rangeStart, $lte: rangeEnd } }),
    });

    const allBranchIds = uniqueObjectIds([
        ...branchIds,
        ...activityBranchIds.filter(Boolean),
        ...leadBranchIds.filter(Boolean),
    ]);

    const branches = await Branch.find(
        { _id: { $in: allBranchIds } },
        { name: true },
    ).lean();
    const branchNameById = new Map(branches.map(branch => [String(branch._id), branch.name]));

    const coveredBranchIds = new Set<string>();
    const stints: PersonStint[] = [];

    for (const membership of memberships) {
        const { stintStart, stintEnd } = clipStintRange(
            membership.startedAt,
            membership.endedAt,
            rangeStart,
            rangeEnd,
        );
        if (stintStart > stintEnd) continue;

        const branchId = membership.branch as Types.ObjectId;
        coveredBranchIds.add(String(branchId));
        stints.push({
            branchId,
            branchName: branchNameById.get(String(branchId)) ?? 'Unknown Branch',
            role: membership.role,
            membership,
            stintStart,
            stintEnd,
        });
    }

    for (const branchId of allBranchIds) {
        if (coveredBranchIds.has(String(branchId))) continue;
        stints.push({
            branchId,
            branchName: branchNameById.get(String(branchId)) ?? 'Unknown Branch',
            role: 'staff',
            membership: null,
            stintStart: rangeStart,
            stintEnd: rangeEnd,
        });
    }

    stints.sort((left, right) => left.stintStart.getTime() - right.stintStart.getTime());
    return stints;
};

const buildPersonReportRows = async (
    userId: Types.ObjectId,
    rangeStart: Date,
    rangeEnd: Date,
    createdAt: { $gte: Date; $lte: Date } | undefined,
    adminIds: Types.ObjectId[],
): Promise<PersonActivityReportRow[]> => {
    const stints = await resolvePersonStints(userId, rangeStart, rangeEnd, createdAt);
    const rows: PersonActivityReportRow[] = [];
    const lastRowByBranch = new Map<string, PersonActivityReportRow>();

    for (let index = 0; index < stints.length; index += 1) {
        const stint = stints[index];
        const stintCreatedAt = {
            $gte: stint.stintStart,
            $lte: stint.stintEnd,
        };

        const metricsByUser = await buildPerUserMetrics({
            branchId: stint.branchId,
            userIds: [userId],
            rangeStart: stint.stintStart,
            rangeEnd: stint.stintEnd,
            createdAt: stintCreatedAt,
            taskCreatedAt: null,
            adminIds,
            ignoreActiveUserFilter: true,
            includeUnscopedBranchActivity: true,
        });

        const metrics = metricsByUser.get(String(userId)) ?? emptyMetrics();

        const previousStint = index > 0 ? stints[index - 1] : null;
        if (
            previousStint?.membership?.endedAt
            && previousStint.membership.endReason === 'transferred'
            && previousStint.membership.endedAt >= rangeStart
        ) {
            rows.push({
                branchName: '',
                periodStart: previousStint.membership.endedAt,
                periodEnd: previousStint.membership.endedAt,
                roleLabel: '',
                isNoteRow: true,
                noteText: `Transferred from ${previousStint.branchName} to ${stint.branchName} on ${formatStintDate(previousStint.membership.endedAt)}`,
                ...emptyMetrics(),
            });
        }

        const row: PersonActivityReportRow = {
            branchName: stint.branchName,
            periodStart: stint.stintStart,
            periodEnd: stint.stintEnd,
            roleLabel: formatRoleLabel(stint.role),
            ...metrics,
        };
        rows.push(row);

        const branchKey = String(stint.branchId);
        const previousRow = lastRowByBranch.get(branchKey);
        if (previousRow) {
            previousRow.pending_tasks = 0;
            previousRow.overdue_tasks = 0;
        }
        lastRowByBranch.set(branchKey, row);
    }

    return rows;
};

const validatePersonReportRows = (rows: PersonActivityReportRow[]): PersonActivityReportRow[] => {
    const dataRows = rows.filter(row => !row.isNoteRow);

    const validatedDataRows = runtimeValidation(
        statsSchema,
        dataRows.map(row => ({
            _id: `${row.branchName}-${row.periodStart.toISOString()}`,
            ...row,
            made_won: 0,
            removed_won: 0,
            call_status_updated: 0,
            total_leads: 0,
        })),
    ).map((row, index) => ({
        branchName: dataRows[index].branchName,
        periodStart: dataRows[index].periodStart,
        periodEnd: dataRows[index].periodEnd,
        roleLabel: dataRows[index].roleLabel,
        task_added: row.task_added ?? 0,
        lead_added: row.lead_added ?? 0,
        overdue_tasks: row.overdue_tasks ?? 0,
        status_updated: row.status_updated ?? 0,
        is_won: row.is_won ?? 0,
        is_visited: row.is_visited ?? 0,
        pending_tasks: row.pending_tasks ?? 0,
    }));

    const validated: PersonActivityReportRow[] = [];
    let dataIndex = 0;
    for (const row of rows) {
        if (row.isNoteRow) {
            validated.push(row);
        } else {
            validated.push(validatedDataRows[dataIndex]);
            dataIndex += 1;
        }
    }
    return validated;
};

export const exportPersonActivityReport = async (req: Request, res: TypedResponse<any>) => {
    try {
        if (req.privilege !== 'admin') {
            throw new AppError('Only admins can export person activity reports', 403);
        }

        const parsedQuery = personReportRequestSchema.parse(req.query);
        const { userId, startDate, endDate } = parsedQuery;
        const rangeStart = startDate ?? new Date(0);
        const rangeEnd = endDate ?? new Date();
        const createdAt = startDate && endDate
            ? { $gte: startDate, $lte: endDate }
            : undefined;

        const user = await User.findById(userId, { username: true, privilege: true }).lean();
        if (!user) {
            throw new AppError('User not found', 404);
        }
        if (user.privilege === 'admin') {
            throw new AppError('Person activity reports are not available for admin users', 400);
        }

        const adminIds = await User
            .find({ privilege: 'admin' }, { _id: true })
            .lean()
            .then(items => items.map(item => item._id));

        const userObjectId = Types.ObjectId.createFromHexString(String(userId));
        const rows = await buildPersonReportRows(
            userObjectId,
            rangeStart,
            rangeEnd,
            createdAt,
            adminIds,
        );

        const validatedRows = validatePersonReportRows(rows);
        const totals = sumActivityReportMetrics(validatedRows.filter(row => !row.isNoteRow));

        const pdfBuffer = await createPdf(generatePersonActivityReportHtml({
            rows: validatedRows,
            totals,
            start: startDate ?? new Date(0),
            end: endDate ?? new Date(),
            personName: user.username,
        }));

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="generated.pdf"',
            'Content-Length': pdfBuffer.length,
        });
        res.end(pdfBuffer);
    } catch (error) {
        console.log('error on person activity report: ', error);
        onCatchError(error, res);
    }
};
