import express from 'express';
import { protect } from '../middleware/auth';
import {
    breakEnd,
    breakStart,
    checkIn,
    checkOut,
    correctCheckout,
    createBreakSubtype,
    createBreakType,
    createPrivilege,
    createScheduleAssignment,
    createScheduleTemplate,
    createShift,
    finalizeDailySnapshots,
    getEmployeeDailySnapshots,
    getEmployeePrivileges,
    getEmployeeSchedule,
    getMonthlySummary,
    getMyDailySnapshots,
    getTeamDailySnapshots,
    listBreakSubtypes,
    listBreakTypes,
    listPrivileges,
    listScheduleAssignments,
    listScheduleTemplates,
    listShifts,
    setEmployeePrivileges,
    updateBreakSubtype,
    updateBreakType,
    updatePrivilege,
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

router.route('/schedule-assignments')
    .post(createScheduleAssignment)
    .get(listScheduleAssignments);

router.get('/employees/:employeeId/schedule', getEmployeeSchedule);

router.post('/events/check-in', checkIn);
router.post('/events/break-start', breakStart);
router.post('/events/break-end', breakEnd);
router.post('/events/check-out', checkOut);

router.get('/me/daily-snapshots', getMyDailySnapshots);
router.get('/team/daily-snapshots', getTeamDailySnapshots);
router.get('/employees/:employeeId/daily-snapshots', getEmployeeDailySnapshots);
router.get('/employees/:employeeId/monthly-summary', getMonthlySummary);

router.post('/jobs/finalize-daily-snapshots', finalizeDailySnapshots);
router.post('/daily-snapshots/:id/corrections/checkout', correctCheckout);

export { router as attendanceRoutes };
