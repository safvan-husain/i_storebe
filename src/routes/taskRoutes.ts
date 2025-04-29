
import express from 'express';
import {
  createTask,
  getTasks,
  // getTaskById,
  // updateTask,
  completeTask, callReports, getTodayTaskStat, getTasksV2,
} from '../controllers/tasks/taskController';
import { protect } from '../middleware/auth';

const router = express.Router();

// Apply authentication middleware to all task routes
router.use(protect);

// Task routes
router.route('/')
  .post(createTask);

router.route('/filter')
    .post(getTasks);

router.route('/v2')
    .post(getTasksV2)

router.route('/complete')
    .post(completeTask);

router.route('/call-reports')
    .get(callReports);

router.route('/today-stat')
    .get(getTodayTaskStat)

// router.route('/:id')
//   .get(getTaskById)
//   .put(updateTask)
  // .delete(deleteTask);

export default router;
