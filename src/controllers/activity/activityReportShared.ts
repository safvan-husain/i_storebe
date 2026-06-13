import { FilterQuery, PipelineStage, Types } from 'mongoose';
import Activity, { IActivity } from '../../models/Activity';
import Branch, { IBranch } from '../../models/Branch';
import BranchMembership, { IBranchMembership } from '../../models/BranchMembership';
import Lead, { ILead } from '../../models/Lead';
import Task, { ITask } from '../../models/Task';
import User, { IUser } from '../../models/User';

export type ActivityReportMetrics = {
    task_added: number;
    lead_added: number;
    overdue_tasks: number;
    status_updated: number;
    is_won: number;
    is_visited: number;
    pending_tasks: number;
};

export type ActivityReportRow = ActivityReportMetrics & {
    displayName: string;
    isNoteRow?: boolean;
};

export type PersonActivityReportRow = ActivityReportMetrics & {
    branchName: string;
    periodStart: Date;
    periodEnd: Date;
    roleLabel: string;
    isNoteRow?: boolean;
    noteText?: string;
};

export const METRIC_KEYS: (keyof ActivityReportMetrics)[] = [
    'task_added',
    'lead_added',
    'overdue_tasks',
    'status_updated',
    'is_won',
    'is_visited',
    'pending_tasks',
];

export const emptyMetrics = (): ActivityReportMetrics => ({
    task_added: 0,
    lead_added: 0,
    overdue_tasks: 0,
    status_updated: 0,
    is_won: 0,
    is_visited: 0,
    pending_tasks: 0,
});

export const isZeroMetrics = (metrics: ActivityReportMetrics) =>
    METRIC_KEYS.every(key => metrics[key] === 0);

export const sumActivityReportMetrics = (
    rows: ActivityReportMetrics[],
): ActivityReportMetrics => {
    const totals = emptyMetrics();
    for (const row of rows) {
        for (const key of METRIC_KEYS) {
            totals[key] += row[key];
        }
    }
    return totals;
};

export const uniqueObjectIds = (ids: Array<Types.ObjectId | string>) =>
    [...new Set(ids.map(String))].map(id => Types.ObjectId.createFromHexString(id));

export const getRosterUserIds = (branch: Pick<IBranch, 'manager' | 'staffs'>) => {
    const roster = new Set<string>();
    if (branch.manager) roster.add(String(branch.manager));
    for (const staffId of branch.staffs ?? []) roster.add(String(staffId));
    return roster;
};

export const getStatusSuffix = (
    user: Pick<IUser, 'isActive'>,
    isOnCurrentRoster: boolean,
    memberships: Pick<IBranchMembership, 'endedAt' | 'endReason'>[],
): string => {
    if (isOnCurrentRoster && user.isActive) return '';
    if (!user.isActive) return ' (inactive)';
    const endedMemberships = memberships.filter(item => item.endedAt);
    if (endedMemberships.some(item => item.endReason === 'removed')) return ' (removed)';
    if (endedMemberships.length > 0) return ' (transferred)';
    if (!isOnCurrentRoster) return ' (transferred)';
    return '';
};

const addActivityMetrics = (metrics: ActivityReportMetrics, type: IActivity['type']) => {
    if (type === 'task_added' || type === 'followup_added') metrics.task_added += 1;
    if (type === 'lead_added') metrics.lead_added += 1;
    if (type === 'status_updated') metrics.status_updated += 1;
    if (type === 'made_won') metrics.is_won += 1;
    if (type === 'removed_won') metrics.is_won -= 1;
};

const missingBranchField = (field: 'actorBranch' | 'createdBranch' | 'handlingBranch') => ({
    $or: [
        { [field]: { $exists: false } },
        { [field]: null },
    ],
});

const getBranchLeadIdsForTasks = async (branchId: Types.ObjectId) =>
    Lead.distinct('_id', {
        $or: [
            { handlingBranch: branchId },
            { ...missingBranchField('handlingBranch'), createdBranch: branchId },
        ],
    });

export const buildPerUserMetrics = async (options: {
    branchId?: Types.ObjectId;
    userIds: Types.ObjectId[];
    rangeStart: Date;
    rangeEnd: Date;
    createdAt?: { $gte: Date; $lte: Date };
    taskCreatedAt?: { $gte: Date; $lte: Date } | null;
    adminIds: Types.ObjectId[];
    ignoreActiveUserFilter: boolean;
    includeTaskMetrics?: boolean;
    scopeTasksByBranch?: boolean;
    includeUnscopedBranchActivity?: boolean;
}): Promise<Map<string, ActivityReportMetrics>> => {
    const {
        branchId,
        userIds,
        rangeStart,
        rangeEnd,
        createdAt,
        taskCreatedAt,
        adminIds,
        ignoreActiveUserFilter,
        includeTaskMetrics = true,
        scopeTasksByBranch = true,
        includeUnscopedBranchActivity = false,
    } = options;

    const metricsByUser = new Map<string, ActivityReportMetrics>();
    const ensureMetrics = (userId: string) => {
        if (!metricsByUser.has(userId)) metricsByUser.set(userId, emptyMetrics());
        return metricsByUser.get(userId)!;
    };

    if (userIds.length === 0) return metricsByUser;

    const activeUserIds = ignoreActiveUserFilter
        ? new Set(userIds.map(String))
        : new Set(
            (await User.find({ _id: { $in: userIds }, isActive: true }, { _id: true }).lean())
                .map(user => String(user._id)),
        );

    const allowedUserIds = userIds
        .map(String)
        .filter(userId => activeUserIds.has(userId));
    const allowedObjectIds = allowedUserIds.map(id => Types.ObjectId.createFromHexString(id));
    if (allowedObjectIds.length === 0) return metricsByUser;

    const activityQuery: FilterQuery<IActivity> = {
        activator: { $in: allowedObjectIds, $nin: adminIds },
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
    };
    if (branchId) {
        if (includeUnscopedBranchActivity) {
            activityQuery.$or = [
                { actorBranch: branchId },
                missingBranchField('actorBranch'),
            ];
        } else {
            activityQuery.actorBranch = branchId;
        }
    }

    const activities = await Activity.find(activityQuery, { activator: true, type: true }).lean();
    for (const activity of activities) {
        addActivityMetrics(ensureMetrics(String(activity.activator)), activity.type);
    }

    const leadQuery: FilterQuery<ILead> = {
        createdBy: { $in: allowedObjectIds },
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
    };
    if (branchId) {
        if (includeUnscopedBranchActivity) {
            leadQuery.$or = [
                { createdBranch: branchId },
                missingBranchField('createdBranch'),
            ];
        } else {
            leadQuery.createdBranch = branchId;
        }
    }

    const leads = await Lead.find(leadQuery, { createdBy: true, enquireStatus: true }).lean();
    for (const lead of leads) {
        const metrics = ensureMetrics(String(lead.createdBy));
        if (lead.enquireStatus === 'visit store') metrics.is_visited += 1;
    }

    if (includeTaskMetrics) {
        const taskQuery: FilterQuery<ITask> = {
            isCompleted: false,
            assigned: { $in: allowedObjectIds },
        };
        if (branchId && scopeTasksByBranch) {
            const branchLeadIds = await getBranchLeadIdsForTasks(branchId);
            taskQuery.lead = { $in: branchLeadIds };
        }
        const taskDateFilter = taskCreatedAt === undefined ? createdAt : taskCreatedAt;
        if (taskDateFilter) taskQuery.createdAt = taskDateFilter;

        const now = new Date();
        const tasks = await Task.find(taskQuery, { assigned: true, due: true }).lean();
        for (const task of tasks) {
            const metrics = ensureMetrics(String(task.assigned));
            metrics.pending_tasks += 1;
            if (task.due < now) metrics.overdue_tasks += 1;
        }
    }

    return metricsByUser;
};

export const aggregateActivityScopeTotals = async (
    matchQuery: FilterQuery<IActivity>,
): Promise<ActivityReportMetrics> => {
    const [result] = await Activity.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: null,
                task_added: {
                    $sum: {
                        $cond: [
                            { $in: ['$type', ['task_added', 'followup_added']] },
                            1,
                            0,
                        ],
                    },
                },
                lead_added: { $sum: { $cond: [{ $eq: ['$type', 'lead_added'] }, 1, 0] } },
                status_updated: { $sum: { $cond: [{ $eq: ['$type', 'status_updated'] }, 1, 0] } },
                made_won: { $sum: { $cond: [{ $eq: ['$type', 'made_won'] }, 1, 0] } },
                removed_won: { $sum: { $cond: [{ $eq: ['$type', 'removed_won'] }, 1, 0] } },
            },
        },
    ]);

    return {
        ...emptyMetrics(),
        task_added: result?.task_added ?? 0,
        lead_added: result?.lead_added ?? 0,
        status_updated: result?.status_updated ?? 0,
        is_won: (result?.made_won ?? 0) - (result?.removed_won ?? 0),
    };
};

export const aggregateLeadScopeTotals = async (
    matchQuery: FilterQuery<ILead>,
): Promise<Pick<ActivityReportMetrics, 'is_visited'>> => {
    const [result] = await Lead.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: null,
                is_visited: {
                    $sum: { $cond: [{ $eq: ['$enquireStatus', 'visit store'] }, 1, 0] },
                },
            },
        },
    ]);

    return { is_visited: result?.is_visited ?? 0 };
};

export const aggregateTaskScopeTotals = async (
    matchQuery: FilterQuery<ITask>,
): Promise<Pick<ActivityReportMetrics, 'pending_tasks' | 'overdue_tasks'>> => {
    const pipeline: PipelineStage[] = [
        { $match: matchQuery },
        {
            $group: {
                _id: null,
                pending_tasks: { $sum: 1 },
                overdue_tasks: {
                    $sum: {
                        $cond: [{ $lt: ['$due', new Date()] }, 1, 0],
                    },
                },
            },
        },
    ];
    const [result] = await Task.aggregate(pipeline);
    return {
        pending_tasks: result?.pending_tasks ?? 0,
        overdue_tasks: result?.overdue_tasks ?? 0,
    };
};

export const getBranchScopeUserIds = async (
    branchId: Types.ObjectId,
    rangeStart: Date,
    rangeEnd: Date,
    createdAt?: { $gte: Date; $lte: Date },
) => {
    const branch = await Branch.findById(branchId, { manager: true, staffs: true }).lean();
    if (!branch) return [];

    const memberships = await BranchMembership.find({
        branch: branchId,
        startedAt: { $lte: rangeEnd },
        $or: [
            { endedAt: { $exists: false } },
            { endedAt: { $gte: rangeStart } },
        ],
    }, { user: true }).lean();

    const activityUserIds = await Activity.distinct('activator', {
        actorBranch: branchId,
        ...(createdAt ? { createdAt } : { createdAt: { $gte: rangeStart, $lte: rangeEnd } }),
    });

    return uniqueObjectIds([
        ...(branch.manager ? [branch.manager] : []),
        ...(branch.staffs ?? []),
        ...memberships.map(item => item.user),
        ...activityUserIds,
    ]);
};

export const buildBranchScopeTotals = async (
    branchId: Types.ObjectId,
    rangeStart: Date,
    rangeEnd: Date,
    createdAt: { $gte: Date; $lte: Date } | undefined,
    adminIds: Types.ObjectId[],
): Promise<ActivityReportMetrics> => {
    const activityScopeMatch: FilterQuery<IActivity> = {
        activator: { $nin: adminIds },
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
        actorBranch: branchId,
    };
    const leadScopeMatch: FilterQuery<ILead> = {
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
        createdBranch: branchId,
    };
    const scopeUserIds = await getBranchScopeUserIds(branchId, rangeStart, rangeEnd, createdAt);
    const taskScopeMatch: FilterQuery<ITask> = {
        isCompleted: false,
        assigned: { $in: scopeUserIds, $nin: adminIds },
    };
    if (createdAt) taskScopeMatch.createdAt = createdAt;

    const [activityTotals, leadTotals, taskTotals] = await Promise.all([
        aggregateActivityScopeTotals(activityScopeMatch),
        aggregateLeadScopeTotals(leadScopeMatch),
        aggregateTaskScopeTotals(taskScopeMatch),
    ]);

    return {
        ...activityTotals,
        is_visited: leadTotals.is_visited,
        pending_tasks: taskTotals.pending_tasks,
        overdue_tasks: taskTotals.overdue_tasks,
    };
};

export const buildCompanyWideTotals = async (
    rangeStart: Date,
    rangeEnd: Date,
    createdAt: { $gte: Date; $lte: Date } | undefined,
    adminIds: Types.ObjectId[],
): Promise<ActivityReportMetrics> => {
    const activityScopeMatch: FilterQuery<IActivity> = {
        activator: { $nin: adminIds },
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
    };
    const leadScopeMatch: FilterQuery<ILead> = {
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
    };
    const scopeUserIds = uniqueObjectIds(
        (await User.find({ privilege: { $ne: 'admin' } }, { _id: true }).lean())
            .map(user => user._id),
    );
    const taskScopeMatch: FilterQuery<ITask> = {
        isCompleted: false,
        assigned: { $in: scopeUserIds, $nin: adminIds },
    };
    if (createdAt) taskScopeMatch.createdAt = createdAt;

    const [activityTotals, leadTotals, taskTotals] = await Promise.all([
        aggregateActivityScopeTotals(activityScopeMatch),
        aggregateLeadScopeTotals(leadScopeMatch),
        aggregateTaskScopeTotals(taskScopeMatch),
    ]);

    return {
        ...activityTotals,
        is_visited: leadTotals.is_visited,
        pending_tasks: taskTotals.pending_tasks,
        overdue_tasks: taskTotals.overdue_tasks,
    };
};

export const buildUserScopeTotals = async (
    userId: Types.ObjectId,
    rangeStart: Date,
    rangeEnd: Date,
    createdAt: { $gte: Date; $lte: Date } | undefined,
    adminIds: Types.ObjectId[],
): Promise<ActivityReportMetrics> => {
    const activityScopeMatch: FilterQuery<IActivity> = {
        activator: userId,
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
    };
    const leadScopeMatch: FilterQuery<ILead> = {
        createdBy: userId,
        createdAt: createdAt ?? { $gte: rangeStart, $lte: rangeEnd },
    };
    const taskScopeMatch: FilterQuery<ITask> = {
        isCompleted: false,
        assigned: userId,
    };

    const [activityTotals, leadTotals, taskTotals] = await Promise.all([
        aggregateActivityScopeTotals(activityScopeMatch),
        aggregateLeadScopeTotals(leadScopeMatch),
        aggregateTaskScopeTotals(taskScopeMatch),
    ]);

    return {
        ...activityTotals,
        is_visited: leadTotals.is_visited,
        pending_tasks: taskTotals.pending_tasks,
        overdue_tasks: taskTotals.overdue_tasks,
    };
};

export const buildBranchSummaryRows = async (
    rangeStart: Date,
    rangeEnd: Date,
    createdAt: { $gte: Date; $lte: Date } | undefined,
    adminIds: Types.ObjectId[],
): Promise<ActivityReportRow[]> => {
    const branches = await Branch.find({ isActive: true }, { name: true })
        .sort({ name: 1 })
        .lean();

    const rows = await Promise.all(branches.map(async branch => ({
        displayName: branch.name,
        ...(await buildBranchScopeTotals(branch._id, rangeStart, rangeEnd, createdAt, adminIds)),
    })));

    return rows;
};

const LOGO_BASE64 = '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';

export const generateActivityReportHtml = (options: {
    rows: ActivityReportRow[];
    totals: ActivityReportMetrics;
    start: Date;
    end: Date;
    branchName?: string;
    rowLabel?: string;
    title?: string;
}) => {
    const {
        rows,
        totals,
        start,
        end,
        branchName,
        rowLabel = 'Username',
        title = 'Activity Summary',
    } = options;
    const headers = [
        rowLabel, 'Tasks Added', 'Leads Added', 'Overdue Task',
        'Status Updates', 'Won', 'Visit', 'Pending Task',
    ];
    const keys: Array<keyof ActivityReportMetrics | 'displayName'> = [
        'displayName', ...METRIC_KEYS,
    ];
    const columnCount = headers.length;

    const bodyRows = rows.map(row => {
        if (row.isNoteRow) {
            return `<tr class="note-row"><td colspan="${columnCount}" style="text-align:left;font-style:italic;">${row.displayName}</td></tr>`;
        }
        return `<tr>${keys.map(key => `<td>${row[key as keyof ActivityReportRow] ?? 0}</td>`).join('')}</tr>`;
    }).join('');

    const totalsRow = `<tr class="totals-row">${[
        'TOTAL',
        ...METRIC_KEYS.map(key => totals[key]),
    ].map(value => `<td><strong>${value}</strong></td>`).join('')}</tr>`;

    const formattedStart = start.toLocaleDateString();
    const formattedEnd = end.toLocaleDateString();

    return `
     <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            background: #f8f9fa;
        }
        h1 {
            text-align: center;
            color: #333;
            font-size: 20px
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            font-size: 13px;
        }
        th, td {
            padding: 10px 6px;
            text-align: center;
            border: 1px solid #dee2e6;
        }
        th {
            background-color: red;
            color: white;
            position: sticky;
            top: 0;
        }
        tr:nth-child(even) {
            background-color: #f1f1f1;
        }
        tr.totals-row td {
            border-top: 2px solid #333;
            background-color: #e9ecef;
        }
        tr.note-row td {
            background-color: #fff8e1;
            font-size: 12px;
        }
        .logo {
            display: block;
            margin: 0 auto 10px auto;
            width: 200px;
            height: auto;
        }
        .date-range {
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 14px;
            color: #555;
        }
        .branch-name {
            position: absolute;
            top: 20px;
            left: 20px;
            font-size: 20px;
            font-weight: bold;
            color: #222;
        }
    </style>
     <div class="date-range">
        <strong>From:</strong> ${formattedStart}<br>
        <strong>To:</strong> ${formattedEnd}
    </div>
    ${branchName ? `<div class="branch-name">${branchName}</div>` : '<div></div>'}
    <img src="data:image/png;base64,${LOGO_BASE64}" class="logo" alt="Logo">
    <h1>${title}</h1>
    <table>
        <thead>
             ${headers.map(h => `<th>${h.replace(' ', '<br>')}</th>`).join('')}
        </thead>
        <tbody>${bodyRows}${totalsRow}</tbody>
    </table>
    `;
};

export const formatStintDate = (date: Date) => date.toLocaleDateString();

export const formatStintPeriod = (start: Date, end: Date) =>
    `${formatStintDate(start)} – ${formatStintDate(end)}`;

export const formatRoleLabel = (role: IBranchMembership['role']) =>
    role === 'manager' ? 'Manager' : 'Staff';

export const generatePersonActivityReportHtml = (options: {
    rows: PersonActivityReportRow[];
    totals: ActivityReportMetrics;
    start: Date;
    end: Date;
    personName: string;
    title?: string;
}) => {
    const {
        rows,
        totals,
        start,
        end,
        personName,
        title = `Activity Report — ${personName}`,
    } = options;

    const headers = [
        'Branch', 'Period', 'Role', 'Tasks Added', 'Leads Added', 'Overdue Task',
        'Status Updates', 'Won', 'Visit', 'Pending Task',
    ];
    const columnCount = headers.length;

    const bodyRows = rows.map(row => {
        if (row.isNoteRow) {
            return `<tr class="note-row"><td colspan="${columnCount}" style="text-align:left;font-style:italic;">${row.noteText ?? ''}</td></tr>`;
        }
        return `<tr>
            <td>${row.branchName}</td>
            <td>${formatStintPeriod(row.periodStart, row.periodEnd)}</td>
            <td>${row.roleLabel}</td>
            ${METRIC_KEYS.map(key => `<td>${row[key]}</td>`).join('')}
        </tr>`;
    }).join('');

    const totalsRow = `<tr class="totals-row">
        <td colspan="3"><strong>Combined Total (all branches)</strong></td>
        ${METRIC_KEYS.map(key => `<td><strong>${totals[key]}</strong></td>`).join('')}
    </tr>`;

    const formattedStart = start.toLocaleDateString();
    const formattedEnd = end.toLocaleDateString();

    return `
     <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            background: #f8f9fa;
        }
        h1 {
            text-align: center;
            color: #333;
            font-size: 20px
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            font-size: 13px;
        }
        th, td {
            padding: 10px 6px;
            text-align: center;
            border: 1px solid #dee2e6;
        }
        th {
            background-color: red;
            color: white;
            position: sticky;
            top: 0;
        }
        tr:nth-child(even) {
            background-color: #f1f1f1;
        }
        tr.totals-row td {
            border-top: 2px solid #333;
            background-color: #e9ecef;
        }
        tr.note-row td {
            background-color: #fff8e1;
            font-size: 12px;
        }
        .logo {
            display: block;
            margin: 0 auto 10px auto;
            width: 200px;
            height: auto;
        }
        .date-range {
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 14px;
            color: #555;
        }
        .person-name {
            position: absolute;
            top: 20px;
            left: 20px;
            font-size: 20px;
            font-weight: bold;
            color: #222;
        }
        .footnote {
            margin-top: 12px;
            font-size: 11px;
            color: #666;
            font-style: italic;
        }
    </style>
     <div class="date-range">
        <strong>From:</strong> ${formattedStart}<br>
        <strong>To:</strong> ${formattedEnd}
    </div>
    <div class="person-name">Person: ${personName}</div>
    <img src="data:image/png;base64,${LOGO_BASE64}" class="logo" alt="Logo">
    <h1>${title}</h1>
    <table>
        <thead>
             ${headers.map(h => `<th>${h.replace(' ', '<br>')}</th>`).join('')}
        </thead>
        <tbody>${bodyRows}${totalsRow}</tbody>
    </table>
    <p class="footnote">Pending and overdue tasks are counted on the branch where the linked lead's handling branch matches. Combined total is the sum of all branch rows above.</p>
    `;
};
