
import express from 'express';
import {
  createTask,
  getTasks,
  getTaskById,
  updateTask, completeTask,
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

router.route('/complete')
    .post(completeTask);

router.route('/:id')
  .get(getTaskById)
  .put(updateTask)
  // .delete(deleteTask);

export default router;
