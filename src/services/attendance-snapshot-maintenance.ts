import { Types } from 'mongoose';
import { regenerateAttendanceDailySnapshot as regenerateFromController } from '../controllers/attendance/attendanceController';

export async function regenerateAttendanceDailySnapshot(params: {
    employeeId: Types.ObjectId;
    branchId: Types.ObjectId;
    dateString: string;
}) {
    return regenerateFromController(params);
}
