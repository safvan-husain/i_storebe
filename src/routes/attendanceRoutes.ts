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
    createScheduleTemplate,
    createShift,
    finalizeDailySnapshots,
    getEmployeeDailySnapshots,
    getEmployeePrivileges,
    getEmployeeSchedule,
    getMyAttendanceStatus,
    getMonthlySummary,
    getMyDailySnapshots,
    getTeamAttendanceAttention,
    getTeamDailySnapshots,
    listBreakSubtypes,
    listBreakTypes,
    listDayOverrides,
    listPrivileges,
    listScheduleAssignments,
    listScheduleGroupMembers,
    listScheduleGroups,
    listScheduleTemplates,
    listShiftMemberships,
    listShifts,
    previewDayOverrides,
    previewScheduleGroupMembers,
    removeScheduleGroupMember,
    removeShiftMembership,
    setEmployeePrivileges,
    setScheduleGroupMembers,
    updateBreakSubtype,
    updateBreakType,
    updateDayOverride,
    updatePrivilege,
    updateScheduleAssignment,
    updateScheduleGroup,
    updateScheduleTemplate,
    updateShift,
} from '../controllers/attendance/attendanceController';

const router = express.Router();

router.use(protect);

router.route('/shifts')
    .post(createShift)
    .get(listShifts);

router.route('/shifts/:id')
    .patch(updateShift);

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

router.route('/schedule-groups/:id/members/preview')
    .post(previewScheduleGroupMembers);

router.route('/schedule-groups/:id/members/:employeeId')
    .delete(removeScheduleGroupMember);

router.route('/schedule-assignments')
    .post(createScheduleAssignment)
    .get(listScheduleAssignments);

router.route('/schedule-assignments/:id')
    .patch(updateScheduleAssignment);

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
