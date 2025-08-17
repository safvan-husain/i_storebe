

import cron from 'node-cron';
import Task from '../models/Task';
import { sendPushNotification } from './notification-services';
import moment from 'moment';
import User from '../models/User';
import { getIndianTime } from '../utils/ist_time';

export const startTaskScheduler = () => {
  // Schedule a job to run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = moment();
      const upcomingTasks = await Task.find({
        due: {
          $gte: now.toDate(),
          $lt: now.clone().add(1, 'minute').toDate(),
        },
        isCompleted: false,
      }).populate('assigned');

      for (const task of upcomingTasks) {
        if (task.assigned && task.assigned._id) {
          const user = task.assigned as any;
          await sendPushNotification({
            title: 'Task Reminder',
            body: `Your task "${task.title}" is due now.`,
            userId: user._id.toString(),
          });
        }
      }
    } catch (error) {
      console.error('Error in task scheduler:', error);
    }
  });

  // Schedule a job to run every day at 11:00 AM IST
  cron.schedule('0 11 * * *', async () => {
    try {
      const users = await User.find({}, { _id: 1 }).lean<{ _id: string }[]>();

      for (const user of users) {
        const today = getIndianTime();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

        const taskCount = await Task.countDocuments({
          assignedTo: user._id,
          dueDate: {
            $gte: startOfDay,
            $lt: endOfDay,
          },
        });

        if (taskCount > 0) {
          const title = `You have ${taskCount} task${taskCount > 1 ? 's' : ''} for today`;
          const body = 'Please complete them';
          await sendPushNotification({ title, body, userId: user._id.toString() });
        }
      }
    } catch (error) {
      console.error('Error sending task notifications:', error);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
};

