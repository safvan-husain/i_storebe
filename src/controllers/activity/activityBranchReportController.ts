import { Request } from 'express';
import { Types } from 'mongoose';
import Branch, { IBranch } from '../../models/Branch';
import BranchMembership, { IBranchMembership } from '../../models/BranchMembership';
import Activity from '../../models/Activity';
import User from '../../models/User';
import { TypedResponse } from '../../common/interface';
import { AppError, onCatchError } from '../../middleware/error';
import { runtimeValidation } from '../../utils/validation';
import { createPdf } from '../../utils/pdf';
import { branchReportRequestSchema, statsSchema } from './validation';
import {
    ActivityReportRow,
    buildBranchScopeTotals,
    buildBranchSummaryRows,
    buildCompanyWideTotals,
    buildPerUserMetrics,
    emptyMetrics,
    generateActivityReportHtml,
    getBranchScopeUserIds,
    getRosterUserIds,
    getStatusSuffix,
    isZeroMetrics,
    uniqueObjectIds,
} from './activityReportShared';

export const exportBranchActivityReport = async (req: Request, res: TypedResponse<any>) => {
    try {
        if (req.privilege !== 'admin') {
            throw new AppError('Only admins can export branch activity reports', 403);
        }

        const parsedQuery = branchReportRequestSchema.parse(req.query);
        const { branch, includeInactiveUsers, startDate, endDate, groupBy } = parsedQuery;
        const rangeStart = startDate ?? new Date(0);
        const rangeEnd = endDate ?? new Date();
        const createdAt = startDate && endDate
            ? { $gte: startDate, $lte: endDate }
            : undefined;

        if (branch && groupBy === 'branch') {
            throw new AppError('Branch summary is only available for all-branches exports', 400);
        }

        const effectiveGroupBy = branch ? 'staff' : (groupBy ?? 'branch');
        const includeInactive = effectiveGroupBy === 'staff' && includeInactiveUsers;

        const adminIds = await User
            .find({ privilege: 'admin' }, { _id: true })
            .lean()
            .then(items => items.map(item => item._id));

        let rows: ActivityReportRow[] = [];
        let branchDoc: Pick<IBranch, '_id' | 'name' | 'manager' | 'staffs'> | null = null;

        if (effectiveGroupBy === 'branch') {
            rows = await buildBranchSummaryRows(rangeStart, rangeEnd, createdAt, adminIds);
        } else {
            let branchId: Types.ObjectId | undefined;
            let rosterUserIds = new Set<string>();

            if (branch) {
                branchDoc = await Branch.findById(branch, { name: true, manager: true, staffs: true }).lean();
                if (!branchDoc) {
                    throw new AppError('Branch not found', 404);
                }
                branchId = branchDoc._id;
                rosterUserIds = getRosterUserIds(branchDoc);
            }

            let candidateUserIds: Types.ObjectId[] = [];

            if (branchId) {
                const scopeUserIds = await getBranchScopeUserIds(branchId, rangeStart, rangeEnd, createdAt);
                if (includeInactive) {
                    candidateUserIds = scopeUserIds;
                } else {
                    const activeRoster = await User.find({
                        _id: { $in: [...rosterUserIds].map(id => Types.ObjectId.createFromHexString(id)) },
                        isActive: true,
                    }, { _id: true }).lean();
                    candidateUserIds = activeRoster.map(user => user._id);
                }
            } else if (includeInactive) {
                const memberships = await BranchMembership.find({
                    startedAt: { $lte: rangeEnd },
                    $or: [
                        { endedAt: { $exists: false } },
                        { endedAt: { $gte: rangeStart } },
                    ],
                }, { user: true }).lean();
                const activityUserIds = await Activity.distinct('activator', {
                    activator: { $nin: adminIds },
                    ...(createdAt ? { createdAt } : { createdAt: { $gte: rangeStart, $lte: rangeEnd } }),
                });
                const activeUsers = await User.find({
                    privilege: { $ne: 'admin' },
                    isActive: true,
                }, { _id: true }).lean();
                candidateUserIds = uniqueObjectIds([
                    ...memberships.map(item => item.user),
                    ...activityUserIds,
                    ...activeUsers.map(user => user._id),
                ]);
            } else {
                const activeUsers = await User.find({
                    privilege: { $ne: 'admin' },
                    isActive: true,
                }, { _id: true }).lean();
                candidateUserIds = activeUsers.map(user => user._id);
            }

            const users = await User.find(
                { _id: { $in: candidateUserIds } },
                { username: true, isActive: true },
            ).lean();

            const membershipsByUser = new Map<string, IBranchMembership[]>();
            if (branchId) {
                const memberships = await BranchMembership.find({
                    branch: branchId,
                    user: { $in: candidateUserIds },
                    startedAt: { $lte: rangeEnd },
                    $or: [
                        { endedAt: { $exists: false } },
                        { endedAt: { $gte: rangeStart } },
                    ],
                }).lean();
                for (const membership of memberships) {
                    const userId = String(membership.user);
                    membershipsByUser.set(userId, [...(membershipsByUser.get(userId) ?? []), membership]);
                }
            }

            const metricsByUserId = await buildPerUserMetrics({
                branchId,
                userIds: candidateUserIds,
                rangeStart,
                rangeEnd,
                createdAt,
                adminIds,
                ignoreActiveUserFilter: includeInactive,
            });

            for (const user of users) {
                const userId = String(user._id);
                const metrics = metricsByUserId.get(userId) ?? emptyMetrics();
                const isOnCurrentRoster = branchId ? rosterUserIds.has(userId) : user.isActive === true;

                if (includeInactive) {
                    if (isZeroMetrics(metrics)) continue;
                } else if (branchId && !rosterUserIds.has(userId)) {
                    continue;
                }

                const suffix = branchId
                    ? getStatusSuffix(user, isOnCurrentRoster, membershipsByUser.get(userId) ?? [])
                    : (!user.isActive ? ' (inactive)' : '');

                rows.push({
                    displayName: `${user.username}${suffix}`,
                    ...metrics,
                });
            }

            rows.sort((left, right) => left.displayName.localeCompare(right.displayName));
        }

        const totals = branch
            ? await buildBranchScopeTotals(
                Types.ObjectId.createFromHexString(branch),
                rangeStart,
                rangeEnd,
                createdAt,
                adminIds,
            )
            : await buildCompanyWideTotals(rangeStart, rangeEnd, createdAt, adminIds);

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
            branchName: branchDoc?.name,
            rowLabel: effectiveGroupBy === 'branch' ? 'Branch' : 'Username',
            title: effectiveGroupBy === 'branch'
                ? 'Activity Summary by Branch'
                : 'Activity Summary',
        }));

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="generated.pdf"',
            'Content-Length': pdfBuffer.length,
        });
        res.end(pdfBuffer);
    } catch (error) {
        console.log('error on branch activity report: ', error);
        onCatchError(error, res);
    }
};
