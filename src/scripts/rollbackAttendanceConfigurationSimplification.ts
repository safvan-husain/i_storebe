import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import connectDb from '../config/db';
import AttendanceShift from '../models/AttendanceShift';
import AttendanceScheduleTemplate, {
    AttendanceScheduleAssignment,
    AttendanceScheduleGroup,
    AttendanceScheduleGroupMembership,
} from '../models/AttendanceSchedule';

async function restoreCollection(model: any, documents: any[], session: any, deleteFilter?: Record<string, unknown>) {
    if (deleteFilter) await model.deleteMany(deleteFilter, { session });
    for (const document of documents) {
        await model.replaceOne({ _id: document._id }, document, { upsert: true, session });
    }
}

async function run() {
    const backupPath = process.argv.slice(2).find((value) => value.startsWith('--backup='))?.slice('--backup='.length);
    const apply = process.argv.includes('--apply');
    if (!backupPath) throw new Error('Use --backup=/absolute/path/to/backup.json');
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (!apply) {
        console.log(JSON.stringify({
            mode: 'dry-run',
            backupPath,
            database: backup.database,
            counts: Object.fromEntries(Object.entries(backup.collections).map(([key, value]) => [key, (value as any[]).length])),
        }, null, 2));
        return;
    }
    await connectDb();
    if (backup.database && backup.database !== mongoose.connection.name) {
        throw new Error(`Backup database ${backup.database} does not match ${mongoose.connection.name}`);
    }
    await mongoose.connection.transaction(async (session) => {
        await restoreCollection(AttendanceShift, backup.collections.shifts, session);
        await restoreCollection(AttendanceScheduleGroup, backup.collections.groups, session);
        await restoreCollection(AttendanceScheduleGroupMembership, backup.collections.memberships, session);
        const templateIds = backup.collections.templates.map((item: any) => item._id);
        const assignmentIds = backup.collections.assignments.map((item: any) => item._id);
        await restoreCollection(AttendanceScheduleAssignment, backup.collections.assignments, session, {
            _id: { $nin: assignmentIds },
            configurationStatus: 'upcoming',
        });
        const referencedTemplateIds = await AttendanceScheduleAssignment.distinct('template', {}, { session });
        await restoreCollection(AttendanceScheduleTemplate, backup.collections.templates, session, {
            _id: { $nin: [...templateIds, ...referencedTemplateIds] },
            name: /^Internal schedule /,
        });
    });
    console.log(JSON.stringify({ mode: 'apply', restoredFrom: backupPath }, null, 2));
    await mongoose.connection.close();
}

if (require.main === module) {
    run().catch(async (error) => {
        console.error(error);
        try { await mongoose.connection.close(); } catch {}
        process.exit(1);
    });
}
