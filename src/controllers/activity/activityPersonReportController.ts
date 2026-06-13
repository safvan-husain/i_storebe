import { Request } from 'express';
import { appendFileSync } from 'fs';
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
    ActivityReportRow,
    buildPerUserMetrics,
    buildUserScopeTotals,
    emptyMetrics,
    formatRoleLabel,
    formatStintDate,
    generateActivityReportHtml,
    isZeroMetrics,
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

const buildStintLabel = (
    branchName: string,
    role: IBranchMembership['role'],
    stintStart: Date,
    stintEnd: Date,
) => `${branchName} — ${formatRoleLabel(role)} (${formatStintDate(stintStart)} – ${formatStintDate(stintEnd)})`;

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
): Promise<ActivityReportRow[]> => {
    const stints = await resolvePersonStints(userId, rangeStart, rangeEnd, createdAt);
    const rows: ActivityReportRow[] = [];

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
            adminIds,
            ignoreActiveUserFilter: true,
            includeTaskMetrics: false,
        });

        const metrics = metricsByUser.get(String(userId)) ?? emptyMetrics();
        if (isZeroMetrics(metrics)) continue;

        const previousStint = index > 0 ? stints[index - 1] : null;
        if (
            previousStint?.membership?.endedAt
            && previousStint.membership.endReason === 'transferred'
            && previousStint.membership.endedAt >= rangeStart
        ) {
            rows.push({
                displayName: `Transferred to ${stint.branchName} on ${formatStintDate(previousStint.membership.endedAt)}`,
                isNoteRow: true,
                ...emptyMetrics(),
            });
        }

        rows.push({
            displayName: buildStintLabel(
                stint.branchName,
                stint.role,
                stint.stintStart,
                stint.stintEnd,
            ),
            ...metrics,
        });
    }

    return rows;
};

export const exportPersonActivityReport = async (req: Request, res: TypedResponse<any>) => {
    try {
        // #region agent log
        try {
            appendFileSync(
                '/Users/safvanhusain/code/hashqubes/istore/.cursor/debug-472d62.log',
                `${JSON.stringify({
                    sessionId: '472d62',
                    runId: 'pre-fix',
                    hypothesisId: 'D',
                    location: 'activityPersonReportController.ts:exportPersonActivityReport',
                    message: 'person report endpoint hit',
                    data: { query: req.query, privilege: req.privilege },
                    timestamp: Date.now(),
                })}\n`,
            );
        } catch {
            // ignore debug log failures in docker/local path differences
        }
        // #endregion
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

        const totals = await buildUserScopeTotals(
            userObjectId,
            rangeStart,
            rangeEnd,
            createdAt,
            adminIds,
        );

        const validatedRows: ActivityReportRow[] = runtimeValidation(
            statsSchema,
            rows.map(row => ({
                _id: row.displayName,
                ...row,
                made_won: 0,
                removed_won: 0,
                call_status_updated: 0,
                total_leads: 0,
            })),
        ).map((row, index) => ({
            displayName: rows[index].displayName,
            isNoteRow: rows[index].isNoteRow,
            task_added: row.task_added ?? 0,
            lead_added: row.lead_added ?? 0,
            overdue_tasks: row.overdue_tasks ?? 0,
            status_updated: row.status_updated ?? 0,
            is_won: row.is_won ?? 0,
            is_visited: row.is_visited ?? 0,
            pending_tasks: row.pending_tasks ?? 0,
        }));

        const pdfBuffer = await createPdf(generateActivityReportHtml({
            rows: validatedRows,
            totals,
            start: startDate ?? new Date(0),
            end: endDate ?? new Date(),
            rowLabel: 'Branch / Period',
            title: `Activity Report — ${user.username}`,
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
