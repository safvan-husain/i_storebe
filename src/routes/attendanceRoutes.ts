import express from 'express';
import { protect } from '../middleware/auth';
import {
    breakEnd,
    breakStart,
    checkIn,
    checkOut,
    correctBreakEnd,
    correctCheckout,
    assignShiftMembers,
    createBreakSubtype,
    createBreakType,
    createDayOverrides,
    createPrivilege,
    createScheduleAssignment,
    createScheduleGroup,
    createConfigurationScheduleGroup,
    createScheduleTemplate,
    createShift,
    createConfigurationShift,
    cancelUpcomingSchedule,
    finalizeDailySnapshots,
    getEmployeeDailySnapshots,
    getEmployeePrivileges,
    getEmployeeSchedule,
    getBranchSchedule,
    getMyAttendanceStatus,
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
    removeShiftMembership,
    setEmployeePrivileges,
    setRemoteWorkerMembers,
    setScheduleGroupMembers,
    updateBreakSubtype,
    updateBreakType,
    updateDayOverride,
    updatePrivilege,
    updateScheduleAssignment,
    updateScheduleGroup,
    updateConfigurationScheduleGroup,
    updateScheduleTemplate,
    updateShift,
    updateConfigurationShift,
    putBranchSchedule,
    putGroupSchedule,
} from '../controllers/attendance/attendanceController';

const router = express.Router();

router.use(protect);

router.route('/shifts')
    .post(createShift)
    .get(listShifts);

router.route('/shifts/:id')
    .patch(updateShift);

router.route('/configuration/shifts')
    .post(createConfigurationShift)
    .get(listConfigurationShifts);

router.route('/configuration/shifts/:id')
    .patch(updateConfigurationShift);

router.route('/shift-memberships')
    .post(assignShiftMembers)
    .get(listShiftMemberships);

router.route('/shift-memberships/:id')
    .delete(removeShiftMembership);

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
    .post(createScheduleTemplate)
    .get(listScheduleTemplates);

router.route('/schedule-templates/:id')
    .patch(updateScheduleTemplate);

router.route('/schedule-groups')
    .post(createScheduleGroup)
    .get(listScheduleGroups);

router.route('/schedule-groups/:id')
    .patch(updateScheduleGroup);

router.route('/schedule-groups/:id/members')
    .get(listScheduleGroupMembers)
    .put(setScheduleGroupMembers);

router.route('/schedule-groups/:id/member-options')
    .get(listScheduleGroupMemberOptions);

router.route('/schedule-groups/:id/members/preview')
    .post(previewScheduleGroupMembers);

router.route('/schedule-groups/:id/members/:employeeId')
    .delete(removeScheduleGroupMember);

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
    .post(createScheduleAssignment)
    .get(listScheduleAssignments);

router.route('/schedule-assignments/:id')
    .patch(updateScheduleAssignment);

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

router.post('/jobs/finalize-daily-snapshots', finalizeDailySnapshots);
router.post('/daily-snapshots/:id/corrections/checkout', correctCheckout);
router.post('/daily-snapshots/:id/corrections/break-end', correctBreakEnd);

export { router as attendanceRoutes };
