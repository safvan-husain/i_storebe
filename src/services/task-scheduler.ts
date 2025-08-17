
import cron from 'node-cron';
import Task from '../models/Task';
import { sendPushNotification } from './notification-services';
import moment from 'moment';

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
};
