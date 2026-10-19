import express from 'express';
import { protect } from '../middleware/auth';
import { registry } from '../openapi/registry';
import { z } from 'zod';
import {
    breakEnd,
    breakStart,
    checkIn,
    checkOut,
    correctBreakEnd,
    correctCheckout,
    createBreakSubtype,
    createBreakType,
    createDayOverrides,
    createPrivilege,
    createConfigurationScheduleGroup,
    createConfigurationShift,
    cancelUpcomingSchedule,
    finalizeDailySnapshots,
    getEmployeeDailySnapshots,
    getEmployeePrivileges,
    getEmployeeSchedule,
    getBranchSchedule,
    getConfigurationShiftCoverageUsage,
    getMyAttendanceStatus,
    getAttendanceRangeSummary,
    exportAttendanceReport,
    getMonthlySummary,
    getMyDailySnapshots,
    getTeamAttendanceAttention,
    getTeamDailySnapshots,
    getRemoteWorkers,
    listRemoteWorkerMemberOptions,
    listBreakSubtypes,
    listBreakTypes,
    listDayOverrides,
    listPrivileges,
    listScheduleAssignments,
    listScheduleGroupMemberOptions,
    listScheduleGroupMembers,
    listConfigurationScheduleGroupMembers,
    listScheduleGroups,
    listConfigurationScheduleGroups,
    listScheduleTemplates,
    listShiftMemberships,
    listShifts,
    listConfigurationShifts,
    previewDayOverrides,
    previewScheduleGroupMembers,
    removeScheduleGroupMember,
    setEmployeePrivileges,
    setRemoteWorkerMembers,
    setScheduleGroupMembers,
    updateBreakSubtype,
    updateBreakType,
    updateDayOverride,
    updatePrivilege,
    updateConfigurationScheduleGroup,
    updateConfigurationShift,
    putBranchSchedule,
    putGroupSchedule,
} from '../controllers/attendance/attendanceController';

const router = express.Router();

const rejectDeprecatedConfigurationWrite: express.RequestHandler = (_req, res) => {
    res.status(410).json({
        message: 'This action is deprecated.',
    });
};

router.use(protect);

router.route('/shifts')
    .post(rejectDeprecatedConfigurationWrite)
    .get(listShifts);

router.route('/shifts/:id')
    .patch(rejectDeprecatedConfigurationWrite);

router.route('/configuration/shifts')
    .post(createConfigurationShift)
    .get(listConfigurationShifts);

router.route('/configuration/shifts/:id')
    .patch(updateConfigurationShift);

router.get('/configuration/shifts/:id/coverage-usage', getConfigurationShiftCoverageUsage);

router.route('/shift-memberships')
    .post(rejectDeprecatedConfigurationWrite)
    .get(listShiftMemberships);

router.route('/shift-memberships/:id')
    .delete(rejectDeprecatedConfigurationWrite);

router.route('/day-overrides')
    .post(createDayOverrides)
    .get(listDayOverrides);

router.route('/day-overrides/preview')
    .post(previewDayOverrides);

router.route('/day-overrides/:id')
    .patch(updateDayOverride);

router.route('/privileges')
    .post(createPrivilege)
    .get(listPrivileges);

router.route('/privileges/:id')
    .patch(updatePrivilege);

router.route('/employees/:employeeId/privileges')
    .put(setEmployeePrivileges)
    .get(getEmployeePrivileges);

router.route('/break-types')
    .post(createBreakType)
    .get(listBreakTypes);

router.route('/break-types/:id')
    .patch(updateBreakType);

router.route('/break-types/:id/subtypes')
    .post(createBreakSubtype)
    .get(listBreakSubtypes);

router.route('/break-subtypes/:id')
    .patch(updateBreakSubtype);

router.route('/schedule-templates')
    .post(rejectDeprecatedConfigurationWrite)
    .get(listScheduleTemplates);

router.route('/schedule-templates/:id')
    .patch(rejectDeprecatedConfigurationWrite);

router.route('/schedule-groups')
    .post(rejectDeprecatedConfigurationWrite)
    .get(listScheduleGroups);

router.route('/schedule-groups/:id')
    .patch(rejectDeprecatedConfigurationWrite);

router.route('/schedule-groups/:id/members')
    .get(listScheduleGroupMembers)
    .put(rejectDeprecatedConfigurationWrite);

router.route('/schedule-groups/:id/member-options')
    .get(listScheduleGroupMemberOptions);

router.route('/schedule-groups/:id/members/preview')
    .post(previewScheduleGroupMembers);

router.route('/schedule-groups/:id/members/:employeeId')
    .delete(rejectDeprecatedConfigurationWrite);

router.route('/configuration/schedule-groups')
    .post(createConfigurationScheduleGroup)
    .get(listConfigurationScheduleGroups);

router.route('/configuration/schedule-groups/:id')
    .patch(updateConfigurationScheduleGroup);

router.route('/configuration/schedule-groups/:id/members')
    .get(listConfigurationScheduleGroupMembers)
    .put(setScheduleGroupMembers);

router.route('/configuration/schedule-groups/:id/member-options')
    .get(listScheduleGroupMemberOptions);

router.route('/configuration/schedule-groups/:id/members/preview')
    .post(previewScheduleGroupMembers);

router.route('/configuration/schedule-groups/:id/members/:employeeId')
    .delete(removeScheduleGroupMember);

router.route('/remote-workers')
    .get(getRemoteWorkers);

router.route('/remote-workers/member-options')
    .get(listRemoteWorkerMemberOptions);

router.route('/remote-workers/members')
    .put(setRemoteWorkerMembers);

router.route('/schedule-assignments')
    .post(rejectDeprecatedConfigurationWrite)
    .get(listScheduleAssignments);

router.route('/schedule-assignments/:id')
    .patch(rejectDeprecatedConfigurationWrite);

router.get('/branch-schedules/:branchId', getBranchSchedule);
router.put('/branch-schedules/:branchId', putBranchSchedule);
router.put('/branch-schedules/:branchId/groups/:groupId', putGroupSchedule);
router.delete('/branch-schedules/upcoming/:changeId', cancelUpcomingSchedule);

router.get('/employees/:employeeId/schedule', getEmployeeSchedule);
router.get('/me/status', getMyAttendanceStatus);

router.post('/events/check-in', checkIn);
router.post('/events/break-start', breakStart);
router.post('/events/break-end', breakEnd);
router.post('/events/check-out', checkOut);

router.get('/me/daily-snapshots', getMyDailySnapshots);
router.get('/team/daily-snapshots/attention', getTeamAttendanceAttention);
router.get('/team/daily-snapshots', getTeamDailySnapshots);
router.get('/employees/:employeeId/daily-snapshots', getEmployeeDailySnapshots);
router.get('/employees/:employeeId/monthly-summary', getMonthlySummary);
router.get('/reports/summary', getAttendanceRangeSummary);
router.get('/reports/export', exportAttendanceReport);

router.post('/jobs/finalize-daily-snapshots', finalizeDailySnapshots);
router.post('/daily-snapshots/:id/corrections/checkout', correctCheckout);
router.post('/daily-snapshots/:id/corrections/break-end', correctBreakEnd);

export { router as attendanceRoutes };


registry.registerPath({
    method: 'get',
    path: '/attendance/reports/export',
    tags: ['Attendance'],
    summary: 'Download attendance summary and daily details as Excel',
    description: 'Admin or HR only. Inclusive branch-local dates; Historical snapshot branches determine export scope, including transferred and inactive employees with attendance. Current members without records are retained unless excluded. Legacy reports/summary keeps its existing scope. Full day >=100%, half day >=50% and <100% of required hours on completed days. Includes break rows and internal employee navigation links.',
    security: [{ bearerAuth: [] }],
    request: { query: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive YYYY-MM-DD start date'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive YYYY-MM-DD end date'),
        employeeId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
        branchId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
        excludeWithoutSnapshots: z.enum(['true', 'false']).optional().describe('Defaults to false; ignored when employeeId is supplied'),
    }) },
    responses: {
        200: { description: 'Excel attachment; Cache-Control: no-store',
            content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                schema: { type: 'string', format: 'binary' },
            } } },
        400: { description: 'Invalid dates, reversed range, IDs or boolean filter' },
        401: { description: 'Missing or invalid Bearer authentication' },
        403: { description: 'Admin or HR privilege required' },
        404: { description: 'Employee or branch not found; missing historical references are shown by ID' },
        422: { description: 'Excel row limit exceeded; reduce range or scope' },
        500: { description: 'Report generation failed; no partial workbook is returned' },
    },
});
