import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import ExcelJS from 'exceljs';
import app from '../src/server';
import User from '../src/models/User';
import Branch from '../src/models/Branch';
import AttendanceDailySnapshot from '../src/models/AttendanceDailySnapshot';
import AttendanceEvent from '../src/models/AttendanceEvent';
import { generateToken } from '../src/utils/jwtUtils';
import * as reportService from '../src/services/attendance-report-export';
import { ReportSnapshot, ReportEvent, classifyWork, reportBreaks, buildAttendanceWorkbook, assertAttendanceRowCapacity } from '../src/services/attendance-report-export';

jest.setTimeout(60000);
const employee = new Types.ObjectId();
const branch = new Types.ObjectId();
const baseSnapshot = (extra: Partial<ReportSnapshot> = {}): ReportSnapshot => ({
    employee, branch, date: '2026-10-12', branchTimezone: 'Asia/Dubai', status: 'present',
    requiredWorkMinutes: 480, productiveWorkMinutes: 480, firstCheckIn: '09:00', lastCheckOut: '18:00',
    totalBreakMinutes: 60, overtimeMinutes: 0, undertimeMinutes: 0,
    breakOvertimeMinutes: 0, breakUndertimeMinutes: 0, breakSessions: [], breakTotals: [],
    generatedBy: 'event', ...extra,
});
const event = (type: ReportEvent['type'], timestamp: string, extra: Partial<ReportEvent> = {}): ReportEvent => ({
    _id: new Types.ObjectId(), employee, branch, branchLocalDate: '2026-10-12',
    type, timestamp: new Date(timestamp), ...extra,
});
const person = { employeeId: String(employee), employeeName: 'Employee', branchName: 'Dubai',
    punchedInDays: 1, presentDays: 1, absentDays: 0, productiveWorkMinutes: 480,
    missingCheckoutDays: 0, excludedIncompleteDays: 0 };
const report = { from: '2026-10-12', to: '2026-10-14', branchId: null, people: [person] };
const serial = (value: ExcelJS.CellValue) => value instanceof Date
    ? (value.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : Number(value);
const decode = async (bytes: Buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    return workbook;
};

describe('Attendance workbook builder', () => {
    test('accepts the final Excel row and rejects overflow on either sheet', () => {
        expect(() => assertAttendanceRowCapacity(1048576, 1048576)).not.toThrow();
        for (const counts of [[1048577, 7], [7, 1048577]]) {
            try { assertAttendanceRowCapacity(counts[0], counts[1]); throw new Error('Expected rejection'); }
            catch (error) { expect(error).toMatchObject({ statusCode: 422 }); }
        }
    });
    test.each([
        [0, 'Less than half day (0%)', 0, 0, 1],
        [239, 'Less than half day (49.8%)', 0, 0, 1],
        [240, 'Half day (50%)', 0, 1, 0],
        [479, 'Half day (99.8%)', 0, 1, 0],
        [480, 'Full day (100%)', 1, 0, 0],
        [540, 'Full day (112.5%)', 1, 0, 0],
    ])('classifies %i minutes using unrounded thresholds', (minutes, label, full, half, lessThanHalf) => {
        expect(classifyWork(baseSnapshot({ productiveWorkMinutes: minutes }))).toMatchObject({ label, full, half, lessThanHalf });
    });
    test('unfinished, off-day, absent and zero-required days do not earn full/half/less-than-half counts', () => {
        for (const s of [
            baseSnapshot({ status: 'open_break' }), baseSnapshot({ lastCheckOut: undefined }),
            baseSnapshot({ status: 'incomplete' }), baseSnapshot({ requiredWorkMinutes: 0 }),
            baseSnapshot({ status: 'absent' }), baseSnapshot({ status: 'off_day' }),
        ]) expect(classifyWork(s)).toMatchObject({ full: 0, half: 0, lessThanHalf: 0 });
    });
    test('summary counts completed days below 50% and excludes unfinished or non-working days', async () => {
        const snapshots = [
            baseSnapshot({ date: '2026-10-01', productiveWorkMinutes: 0 }),
            baseSnapshot({ date: '2026-10-02', productiveWorkMinutes: 239 }),
            baseSnapshot({ date: '2026-10-03', productiveWorkMinutes: 240 }),
            baseSnapshot({ date: '2026-10-04', productiveWorkMinutes: 241 }),
            baseSnapshot({ date: '2026-10-05', productiveWorkMinutes: 480 }),
            baseSnapshot({ date: '2026-10-06', productiveWorkMinutes: 10, status: 'absent' }),
            baseSnapshot({ date: '2026-10-07', productiveWorkMinutes: 10, status: 'off_day' }),
            baseSnapshot({ date: '2026-10-08', productiveWorkMinutes: 10, status: 'incomplete' }),
            baseSnapshot({ date: '2026-10-09', productiveWorkMinutes: 10, status: 'open_break' }),
            baseSnapshot({ date: '2026-10-10', productiveWorkMinutes: 10, lastCheckOut: undefined }),
            baseSnapshot({ date: '2026-10-11', productiveWorkMinutes: 10, requiredWorkMinutes: 0 }),
        ];
        const book = await decode(await buildAttendanceWorkbook(report, snapshots, []));
        const summary = book.getWorksheet('Summary')!;
        expect(summary.getCell('D7').value).toBe(1);
        expect(summary.getCell('E7').value).toBe(2);
        expect(summary.getCell('F7').value).toBe(2);
        expect(summary.getCell('G6').value).toBe('Absent days');
        expect(summary.getCell('H6').value).toBe('Total worked');
        expect(summary.getCell('K7').hyperlink).toBe("#'Daily details'!A7");
        expect(book.getWorksheet('Daily details')!.getCell('V7').hyperlink).toBe("#'Summary'!A7");
    });
    test('shows completion only in the existing day label, without a duplicate percentage column', async () => {
        const book = await decode(await buildAttendanceWorkbook(report, [
            baseSnapshot({ productiveWorkMinutes: 360 }),
        ], []));
        const sheet = book.getWorksheet('Daily details')!;
        expect(sheet.getCell('M6').value).toBe('Work completion');
        expect(sheet.getCell('M7').value).toBe('Half day (75%)');
        expect(sheet.getRow(6).values).not.toContain('Completion %');
        expect(sheet.columnCount).toBe(22);
    });
    test('break rows preserve corrections and branch-local overnight dates; missing history is explicit', async () => {
        const start = event('break_start', '2026-10-12T19:45:00Z');
        const end = event('break_end', '2026-10-12T20:15:00Z');
        const open = event('break_start', '2026-10-12T21:00:00Z');
        const snapshot = baseSnapshot({ generatedBy: 'correction', notes: 'Approved correction',
            breakSessions: [{
                startEventId: start._id, endEventId: end._id,
                startAt: start.timestamp, endAt: end.timestamp,
                startLocalTime: '23:45', endLocalTime: '00:15', minutes: 25,
                allowedMinutes: 25, excessMinutes: 0, unusedAllowedMinutes: 0, overtimeMinutes: 0, undertimeMinutes: 0,
                breakTypeName: 'Lunch',
            }] });
        const breaks = reportBreaks(snapshot, [start, end, open]);
        expect(breaks).toHaveLength(2);
        expect(breaks[0].minutes).toBe(25);
        expect(breaks[1].missingEnd).toBe(true);
        const book = await decode(await buildAttendanceWorkbook(report, [snapshot], [start, end, open]));
        const sheet = book.getWorksheet('Daily details')!;
        expect(sheet.getCell('O7').value).toBe('Approved correction');
        expect(sheet.getCell('S7').value).toContain('12 Oct 2026');
        expect(sheet.getCell('T7').value).toContain('13 Oct 2026');
        expect(serial(sheet.getCell('U7').value)).toBeCloseTo(25 / 1440);
        expect(sheet.getCell('T8').value).toBe('Break-out not recorded');
        expect(sheet.getCell('S8').value).toContain('13 Oct 2026');
        expect(sheet.getCell('U8').value).toBeNull();
        expect(sheet.getCell('D8').value).toBeNull();
        expect(sheet.getCell('M7').value).toContain('Missing break-out');
        const legacy = await decode(await buildAttendanceWorkbook(report, [baseSnapshot()], []));
        expect(legacy.getWorksheet('Daily details')!.getCell('P8').value).toBe('Historical break details unavailable');
    });
    test('events recover legacy sessions and missing starts without writing metrics', () => {
        const start = event('break_start', '2026-10-12T09:00:00Z');
        const end = event('break_end', '2026-10-12T09:20:00Z');
        expect(reportBreaks(baseSnapshot(), [start, end])[0].minutes).toBe(20);
        expect(reportBreaks(baseSnapshot(), [end])[0].missingStart).toBe(true);
    });
    test('recovers an overnight break when return belongs to the following local date', async () => {
        const start = event('break_start', '2026-10-12T19:45:00Z');
        const end = event('break_end', '2026-10-12T20:15:00Z', { branchLocalDate: '2026-10-13' });
        const book = await decode(await buildAttendanceWorkbook(report, [baseSnapshot()], [start, end]));
        const sheet = book.getWorksheet('Daily details')!;
        expect(sheet.getCell('S7').value).toContain('12 Oct 2026');
        expect(sheet.getCell('T7').value).toContain('13 Oct 2026');
        expect(serial(sheet.getCell('U7').value)).toBeCloseTo(30 / 1440);
        expect(sheet.getCell('M7').value).toBe('Full day (100%)');
    });
    test('people without snapshots get a working link to an empty section', async () => {
        const book = await decode(await buildAttendanceWorkbook(report, [], []));
        expect(book.worksheets.map(s => s.name)).toEqual(['Summary', 'Daily details']);
        expect(book.getWorksheet('Summary')!.getCell('K7').hyperlink).toBe("#'Daily details'!A7");
        expect(book.getWorksheet('Daily details')!.getCell('C7').value).toBe('No records in selected period');
        expect(book.getWorksheet('Daily details')!.getCell('V7').hyperlink).toBe("#'Summary'!A7");
    });
    test('keeps an unmatched break-in on the daily row with a red missing-out label and no duration', async () => {
        const start = event('break_start', '2026-10-12T09:00:00Z');
        const book = await decode(await buildAttendanceWorkbook(report, [baseSnapshot({
            status: 'missing_checkout', lastCheckOut: undefined, totalBreakMinutes: 0,
        })], [start]));
        const sheet = book.getWorksheet('Daily details')!;
        expect(sheet.getCell('S7').value).toContain('13:00');
        expect(sheet.getCell('T7').value).toBe('Break-out not recorded');
        expect(sheet.getCell('T7').font.color?.argb).toBe('FFB42318');
        expect(sheet.getCell('U7').value).toBeNull();
        expect(sheet.getCell('P7').value).not.toContain('No break taken');
    });
    test('labels no breaks and only flags excess break time rather than unused allowance', async () => {
        const snapshots = [
            baseSnapshot({ totalBreakMinutes: 0 }),
            baseSnapshot({ date: '2026-10-13', totalBreakMinutes: 17, breakOvertimeMinutes: 43,
                breakTotals: [{ breakTypeName: 'Default', minutes: 17, allowedMinutes: 17,
                    unusedAllowedMinutes: 43, excessMinutes: 0, overtimeMinutes: 43, undertimeMinutes: 0 }] }),
            baseSnapshot({ date: '2026-10-14', totalBreakMinutes: 70, breakUndertimeMinutes: 10 }),
        ];
        const book = await decode(await buildAttendanceWorkbook(report, snapshots, []));
        const sheet = book.getWorksheet('Daily details')!;
        expect(sheet.getCell('P7').value).toBe('No break taken');
        expect(sheet.getCell('P8').value).toBe('Default: 17m taken, 43m unused allowance, 0m excess');
        expect(sheet.getCell('F8').font.color?.argb).not.toBe('FFB42318');
        expect(sheet.getCell('F10').font.color?.argb).toBe('FFB42318');
    });
});

describe('Attendance export HTTP', () => {
    let mongo: MongoMemoryServer;
    let adminToken: string;
    let staffToken: string;
    let hrToken: string;
    let staffId: string;
    let branchId: string;
    beforeAll(async () => {
        mongo = await MongoMemoryServer.create();
        await mongoose.connect(mongo.getUri());
        const admin = await User.create({ username: 'export-admin', privilege: 'admin', password: 'test-password', isActive: true });
        const staff = await User.create({ username: 'export-staff', privilege: 'staff', password: 'test-password', isActive: true });
        const hr = await User.create({ username: 'export-hr', privilege: 'staff', secondPrivilege: 'hr', password: 'test-password', isActive: true });
        adminToken = generateToken(admin); staffToken = generateToken(staff); hrToken = generateToken(hr);
        staffId = String(staff._id);
        const b = await Branch.create({ name: 'Export branch', normalizedName: 'export-branch',
            staffs: [staff._id, hr._id], isActive: true, createdBy: admin._id, timezone: 'Asia/Dubai' });
        branchId = String(b._id);
        await AttendanceDailySnapshot.create([
            { ...baseSnapshot(), employee: staff._id, branch: b._id },
            { ...baseSnapshot({ productiveWorkMinutes: 240, date: '2026-10-13' }), employee: staff._id, branch: b._id },
            { ...baseSnapshot({ productiveWorkMinutes: 60, date: '2026-10-14',
                status: 'missing_checkout', lastCheckOut: undefined }), employee: staff._id, branch: b._id },
        ]);
    });
    afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
    const get = (token?: string, params: Record<string, string | undefined> = {}) => {
        const req = request(app).get('/api/attendance/reports/export')
            .query({ from: '2026-10-12', to: '2026-10-14', ...params })
            .buffer(true).parse((res, callback) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
                res.on('end', () => callback(null, Buffer.concat(chunks)));
                res.on('error', callback);
            });
        return token ? req.set('Authorization', 'Bearer ' + token) : req;
    };
    test('requires Bearer authentication and admin/HR privilege', async () => {
        expect((await get()).status).toBe(401);
        expect((await get('invalid')).status).toBe(401);
        expect((await get(staffToken)).status).toBe(403);
        expect((await get(hrToken, { employeeId: staffId })).status).toBe(200);
    });
    test.each([
        { from: '2026-02-30' }, { from: '2026-13-01' }, { from: 'bad' },
        { from: '2026-10-15', to: '2026-10-12' }, { employeeId: 'invalid' }, { branchId: 'invalid' },
        { excludeWithoutSnapshots: 'invalid' },
    ])('rejects invalid query %j', async query => {
        expect((await get(adminToken, query)).status).toBe(400);
    });
    test('returns 404 for unknown references but permits historical person/branch queries', async () => {
        expect((await get(adminToken, { employeeId: String(new Types.ObjectId()) })).status).toBe(404);
        expect((await get(adminToken, { branchId: String(new Types.ObjectId()) })).status).toBe(404);
        const b = await Branch.findById(branchId);
        expect((await get(adminToken, { employeeId: String(b!.createdBy), branchId })).status).toBe(200);
    });
    test('downloads a complete workbook with consistent summary totals, counters and every link', async () => {
        const response = await get(adminToken, { branchId });
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain(reportService.EXCEL_MIME);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-disposition']).toContain('attendance_report_2026-10-12_2026-10-14.xlsx');
        const book = await decode(response.body);
        const summary = book.getWorksheet('Summary')!;
        const details = book.getWorksheet('Daily details')!;
        const json = await request(app).get('/api/attendance/reports/summary')
            .query({ from: '2026-10-12', to: '2026-10-14', branchId })
            .set('Authorization', 'Bearer ' + adminToken);
        const summaryPerson = json.body.people.find((p: {employeeId: string}) => p.employeeId === staffId);
        let staffRow = 0;
        summary.eachRow(row => { if (row.getCell(1).value === 'export-staff') staffRow = row.number; });
        expect(summary.getCell('D' + staffRow).value).toBe(1);
        expect(summary.getCell('E' + staffRow).value).toBe(1);
        expect(summary.getCell('F6').value).toBe('Less than half days');
        expect(summary.getCell('F' + staffRow).value).toBe(0);
        expect(summary.getCell('C' + staffRow).value).toBe(summaryPerson.punchedInDays);
        expect(serial(summary.getCell('H' + staffRow).value) * 1440).toBeCloseTo(summaryPerson.productiveWorkMinutes);
        for (const sheet of book.worksheets) sheet.eachRow(row => row.eachCell(cell => {
            if (!cell.hyperlink) return;
            const target = /^#'([^']+)'!(A\d+)$/.exec(cell.hyperlink);
            expect(target).not.toBeNull();
            const name = book.getWorksheet(target![1])!.getCell(target![2]).value;
            expect(name).toBe(row.getCell(1).value);
        }));
        expect(details.views[0].state).toBe('frozen');
        expect(json.body.people[0]).not.toHaveProperty('fullDays');
    });
    test('single-person export and no-snapshot filter retain existing scope rules', async () => {
        const response = await get(adminToken, { employeeId: staffId, branchId, excludeWithoutSnapshots: 'true' });
        const book = await decode(response.body);
        expect(book.getWorksheet('Summary')!.rowCount).toBe(7);
        const filtered = await decode((await get(adminToken, { branchId, excludeWithoutSnapshots: 'true' })).body);
        expect(filtered.getWorksheet('Summary')!.rowCount).toBe(7);
        const empty = await decode((await get(adminToken, { from: '2000-01-01', to: '2000-01-01', excludeWithoutSnapshots: 'true' })).body);
        expect(empty.getWorksheet('Summary')!.getCell('A7').value).toBe('No records');
    });
    test('generation failure returns JSON without attachment headers or a partial workbook', async () => {
        const spy = jest.spyOn(reportService, 'buildAttendanceWorkbook').mockRejectedValueOnce(new Error('Test export failure'));
        try {
            const response = await get(adminToken);
            expect(response.status).toBe(500);
            expect(response.headers['content-type']).toContain('application/json');
            expect(response.headers['content-disposition']).toBeUndefined();
        } finally { spy.mockRestore(); }
    });
    test('export leaves attendance snapshots and events unchanged', async () => {
        const before = await AttendanceDailySnapshot.find().lean();
        const eventCount = await AttendanceEvent.countDocuments();
        await get(adminToken);
        expect(await AttendanceDailySnapshot.find().lean()).toEqual(before);
        expect(await AttendanceEvent.countDocuments()).toBe(eventCount);
    });
    test('historical branch exports include transfers, inactive people and missing references without changing JSON scope', async () => {
        const user = await User.create({ username: 'transferred-person', password: 'test-password',
            privilege: 'staff', isActive: true });
        const a = await Branch.create({ name: 'History A', normalizedName: 'history-a', staffs: [],
            isActive: true, createdBy: user._id });
        const b = await Branch.create({ name: 'History B', normalizedName: 'history-b', staffs: [user._id],
            isActive: true, createdBy: user._id });
        await AttendanceDailySnapshot.create([
            { ...baseSnapshot(), employee: user._id, branch: a._id },
            { ...baseSnapshot({ date: '2026-10-13' }), employee: user._id, branch: b._id },
            { ...baseSnapshot({ date: '2026-10-14' }), employee: user._id, branch: a._id },
        ]);
        const all = await decode((await get(adminToken, { employeeId: String(user._id) })).body);
        expect(all.getWorksheet('Summary')!.getCell('B7').value).toBe('History A, History B');
        const details = all.getWorksheet('Daily details')!;
        expect(details.getCell('R6').value).toBe('Branch');
        const branchLabels: string[] = [];
        details.eachRow(row => {
            if (row.number > 6 && row.getCell(1).value) branchLabels.push(String(row.getCell(18).value));
        });
        expect(branchLabels).toEqual(['History A', 'History B', 'History A']);
        const sumFor = async (id: string) => {
            const book = await decode((await get(adminToken, { branchId: id, excludeWithoutSnapshots: 'true' })).body);
            const sheet = book.getWorksheet('Summary')!;
            let rowNumber = 0;
            sheet.eachRow(row => { if (row.getCell(1).value === 'transferred-person') rowNumber = row.number; });
            expect(rowNumber).toBeGreaterThan(6);
            return serial(sheet.getCell('H' + rowNumber).value) * 1440;
        };
        expect(await sumFor(String(a._id))).toBeCloseTo(960);
        expect(await sumFor(String(b._id))).toBeCloseTo(480);
        expect(serial(all.getWorksheet('Summary')!.getCell('H7').value) * 1440).toBeCloseTo(1440);
        const legacy = await request(app).get('/api/attendance/reports/summary')
            .query({ from: '2026-10-12', to: '2026-10-14', branchId: String(a._id) })
            .set('Authorization', 'Bearer ' + adminToken);
        expect(legacy.body.people).toEqual([]);
        await User.updateOne({ _id: user._id }, { $set: { isActive: false } });
        await Branch.updateOne({ _id: a._id }, { $set: { isActive: false } });
        expect(await sumFor(String(a._id))).toBeCloseTo(960);
        const missingEmployee = new Types.ObjectId(), missingBranch = new Types.ObjectId();
        await AttendanceDailySnapshot.create({ ...baseSnapshot(), employee: missingEmployee, branch: missingBranch });
        const unknown = await decode((await get(adminToken, { employeeId: String(missingEmployee) })).body);
        expect(unknown.getWorksheet('Summary')!.getCell('A7').value).toContain(String(missingEmployee));
        expect(unknown.getWorksheet('Summary')!.getCell('B7').value).toContain(String(missingBranch));
    });

});
