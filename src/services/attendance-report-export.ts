import ExcelJS from 'exceljs';
import type { IAttendanceDailySnapshot } from '../models/AttendanceDailySnapshot';
import type { IAttendanceEvent } from '../models/AttendanceEvent';
import { AppError } from '../middleware/error';

export type ReportSnapshot = Pick<IAttendanceDailySnapshot,
    'employee' | 'branch' | 'date' | 'branchTimezone' | 'status' | 'requiredWorkMinutes' |
    'productiveWorkMinutes' | 'firstCheckIn' | 'lastCheckOut' | 'firstCheckInAt' | 'lastCheckOutAt' |
    'totalBreakMinutes' | 'overtimeMinutes' | 'undertimeMinutes' | 'breakOvertimeMinutes' |
    'breakUndertimeMinutes' | 'breakSessions' | 'breakTotals' | 'generatedBy' | 'notes'> & { branchName?: string };
export type ReportEvent = Pick<IAttendanceEvent,
    '_id' | 'employee' | 'branch' | 'branchLocalDate' | 'type' | 'timestamp' | 'breakType' | 'breakSubtype'>;
export type ReportPerson = {
    employeeId: string; employeeName: string; branchId?: string; branchName?: string; branchNames?: string[];
    punchedInDays: number; presentDays: number; absentDays: number; productiveWorkMinutes: number;
    missingCheckoutDays: number; excludedIncompleteDays: number;
};
export type RangeReport = { from: string; to: string; branchId: string | null; people: ReportPerson[] };
type ReportBreak = {
    startEventId?: unknown; endEventId?: unknown; startAt?: Date; endAt?: Date;
    startLocalTime?: string; endLocalTime?: string; minutes?: number;
    breakTypeName?: string; breakSubtypeName?: string;
    missingStart?: boolean; missingEnd?: boolean;
};
const MAX_ROWS = 1048576;
export function assertAttendanceRowCapacity(summaryRows: number, detailRows: number) {
    if (summaryRows > MAX_ROWS || detailRows > MAX_ROWS) {
        throw new AppError('Report exceeds the Excel row limit; select a smaller date range or employee scope', 422);
    }
}
export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const reportKey = (employee: unknown, branch: unknown, date: string) =>
    `${String(employee)}:${String(branch)}:${date}`;

function validDate(value?: Date): boolean {
    return value != null && Number.isFinite(new Date(value).getTime());
}

/** Stored sessions own completed break values; events fill gaps, never overwrite corrections. */
export function reportBreaks(snapshot: ReportSnapshot, events: ReportEvent[]): ReportBreak[] {
    const stored = snapshot.breakSessions ?? [];
    const result: ReportBreak[] = stored.map(session => ({ ...session }));
    const byId = new Map(events.map(event => [String(event._id), event]));
    for (const session of result) {
        const start = byId.get(String(session.startEventId));
        const end = byId.get(String(session.endEventId));
        if (!validDate(session.startAt) && start) session.startAt = start.timestamp;
        if (!validDate(session.endAt) && end) session.endAt = end.timestamp;
    }
    const pending: ReportEvent[] = [];
    const accountedStarts = new Set(result.map(s => String(s.startEventId)));
    const accountedEnds = new Set(result.map(s => String(s.endEventId)));
    const sameTime = (a?: Date, b?: Date) => validDate(a) && validDate(b) &&
        new Date(a!).getTime() === new Date(b!).getTime();
    const label = (event: ReportEvent) => {
        const known = (snapshot.breakTotals ?? []).find(total =>
            String(total.breakType) === String(event.breakType) &&
            String(total.breakSubtype) === String(event.breakSubtype));
        return { breakTypeName: known?.breakTypeName, breakSubtypeName: known?.breakSubtypeName };
    };
    for (const event of events) {
        if (event.type === 'break_start') pending.push(event);
        if (event.type !== 'break_end') continue;
        const start = pending.shift();
        const existing = result.find(s =>
            (start && (String(s.startEventId) === String(start._id) || sameTime(s.startAt, start.timestamp))) ||
            String(s.endEventId) === String(event._id) || sameTime(s.endAt, event.timestamp));
        if (existing) {
            if (!validDate(existing.startAt) && start) existing.startAt = start.timestamp;
            if (!validDate(existing.endAt)) existing.endAt = event.timestamp;
            continue;
        }
        if (accountedEnds.has(String(event._id)) || (start && accountedStarts.has(String(start._id)))) continue;
        result.push({
            startAt: start?.timestamp, endAt: event.timestamp,
            startEventId: start?._id, endEventId: event._id, missingStart: !start,
            // Duration is unavailable when there is no start.
            minutes: start ? Math.max(0, Math.floor((event.timestamp.getTime() - start.timestamp.getTime()) / 60000)) : undefined,
            ...label(start ?? event),
        });
    }
    for (const start of pending) {
        if (result.some(s => String(s.startEventId) === String(start._id) || sameTime(s.startAt, start.timestamp))) continue;
        result.push({ startEventId: start._id, startAt: start.timestamp, missingEnd: true, ...label(start) });
    }
    for (const session of result) {
        session.missingStart = !validDate(session.startAt) && !session.startLocalTime;
        session.missingEnd = !validDate(session.endAt) && !session.endLocalTime;
        if (session.missingStart || session.missingEnd) session.minutes = undefined;
    }
    return result.sort((a, b) => {
        const key = (s: ReportBreak) => validDate(s.startAt) ? new Date(s.startAt!).getTime()
            : validDate(s.endAt) ? new Date(s.endAt!).getTime() : Number.MAX_SAFE_INTEGER;
        return key(a) - key(b);
    });
}

export function classifyWork(snapshot: ReportSnapshot, breaks: ReportBreak[] = []) {
    const openBreak = snapshot.status === 'open_break' || breaks.some(b =>
        b.missingEnd || (!validDate(b.endAt) && !b.endLocalTime));
    const hasIn = Boolean(snapshot.firstCheckIn || snapshot.firstCheckInAt);
    const hasOut = Boolean(snapshot.lastCheckOut || snapshot.lastCheckOutAt);
    if (snapshot.status === 'absent') return { status: 'Absent', label: 'Absent (0%)', full: 0, half: 0, lessThanHalf: 0 };
    if (snapshot.status === 'off_day') return { status: 'Off day', label: 'Off day (N/A)', full: 0, half: 0, lessThanHalf: 0 };
    const missingCheckout = snapshot.status === 'missing_checkout' || (hasIn && !hasOut);
    const incompleteBreak = breaks.some(b => b.missingStart);
    const status = openBreak ? (missingCheckout ? 'Missing checkout / Missing break-out' : 'Missing break-out')
        : missingCheckout ? 'Missing checkout'
        : incompleteBreak ? 'Missing break-in'
        : snapshot.status !== 'present' ? 'Incomplete' : 'Present';
    if (status !== 'Present' || !hasOut || !Number.isFinite(snapshot.requiredWorkMinutes) ||
        !Number.isFinite(snapshot.productiveWorkMinutes) || snapshot.requiredWorkMinutes <= 0) {
        return { status, label: `${status} (N/A)`, full: 0, half: 0, lessThanHalf: 0 };
    }
    const ratio = snapshot.productiveWorkMinutes / snapshot.requiredWorkMinutes;
    const full = ratio >= 1 ? 1 : 0;
    const half = ratio >= 0.5 && ratio < 1 ? 1 : 0;
    const percentage = Number((ratio * 100).toFixed(1));
    return {
        status, full, half, lessThanHalf: ratio < 0.5 ? 1 : 0,
        label: `${full ? 'Full day' : half ? 'Half day' : 'Less than half day'} (${percentage}%)`,
    };
}

function timestamp(value: Date | undefined, localTime: string | undefined, timezone: string, date: string) {
    if (!validDate(value)) return localTime ? `${localTime} (date unavailable)` : 'Unavailable';
    try {
        // Strings intentionally describe branch-local wall time, independent of the reader's timezone.
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone, year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date(value!));
    } catch {
        return 'Unavailable (invalid timezone)';
    }
}
function styleSheet(sheet: ExcelJS.Worksheet, widths: number[], title: string, report: RangeReport) {
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 6, showGridLines: false }];
    sheet.addRow([title]);
    sheet.getCell('A1').font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF243B53' } };
    sheet.addRow(['Date range', `${report.from} to ${report.to}`]);
    sheet.addRow(['Definition', 'Completion = productive / required hours. Full ≥100%; half ≥50% and <100%. Breaks are already excluded. Unfinished: N/A.']);
    sheet.addRow(['Definition', 'Punched-in days includes unfinished days. Total worked includes stored Present snapshots only.']);
    sheet.addRow(['Times', 'Branch-local date and time. Break-in = break start; break-out = return.']);
    widths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}
function header(sheet: ExcelJS.Worksheet, values: string[]) {
    const row = sheet.addRow(values);
    row.height = 32;
    row.eachCell(cell => {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243B53' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
}
function body(row: ExcelJS.Row, shade = false) {
    row.height = 28;
    row.eachCell({ includeEmpty: true }, cell => {
        cell.font = { name: 'Arial', size: 10, color: { argb: 'FF1F2937' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
        if (typeof cell.value === 'string') {
            const charsPerLine = Math.max(8, (cell.worksheet.getColumn(cell.col).width ?? 20) - 2);
            const lines = cell.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
            row.height = Math.max(row.height ?? 28, Math.min(409, lines * 13 + 6));
        }
        if (shade) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0F6' } };
    });
}
function link(cell: ExcelJS.Cell, target: string, text: string) {
    cell.value = { text, hyperlink: `#${target}`, tooltip: text };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
}
function duration(cell: ExcelJS.Cell, minutes: number | undefined) {
    cell.value = minutes === undefined ? 'N/A' : minutes / 1440;
    cell.alignment = { horizontal: 'right', vertical: 'middle' };
    cell.numFmt = '[h]"h "mm"m"';
}
function markBelowExpected(cell: ExcelJS.Cell) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE8E7' } };
    cell.font = { name: 'Arial', size: 10, color: { argb: 'FFB42318' } };
}

/** Pure workbook builder: no database writes or snapshot regeneration. */
export async function buildAttendanceWorkbook(
    report: RangeReport, snapshots: ReportSnapshot[], events: ReportEvent[],
) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'iStore';
    const summary = workbook.addWorksheet('Summary');
    const details = workbook.addWorksheet('Daily details');
    styleSheet(summary, [25, 24, 18, 13, 13, 21, 14, 18, 23, 28, 24], 'Attendance summary', report);
    styleSheet(details, [25, 18, 24, 16, 16, 16, 16, 16, 19, 19, 25, 25, 36, 24, 24, 32, 26, 24, 24, 24, 17, 23],
        'Attendance daily details', report);
    header(summary, ['Person', 'Branches', 'Punched-in days', 'Full days', 'Half days', 'Less than half days', 'Absent days',
        'Total worked', 'Missing checkout days', 'Incomplete/open-break days', 'Daily log']);
    header(details, ['Person', 'Date', 'Status', 'Required hours', 'Productive hours', 'Break',
        'Overtime', 'Undertime', 'Unused break allowance', 'Excess break time', 'Check in', 'Check out',
        'Work completion', 'Updated', 'Correction reason', 'Break details', 'Timezone', 'Branch',
        'Break-in', 'Break-out', 'Break duration', 'Navigation']);
    const eventGroups = new Map<string, ReportEvent[]>();
    const pendingEvents = new Map<string, ReportEvent[]>();
    const appendEvent = (event: ReportEvent, ownerDate = event.branchLocalDate) => {
        const key = reportKey(event.employee, event.branch, ownerDate);
        const list = eventGroups.get(key) ?? [];
        list.push(event);
        eventGroups.set(key, list);
    };
    // An overnight break belongs to its start day's snapshot, even if return is next day.
    for (const event of [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
        const key = String(event.employee) + ':' + String(event.branch);
        const pending = pendingEvents.get(key) ?? [];
        if (event.type === 'break_start') {
            pending.push(event);
        } else if (event.type === 'break_end') {
            // Do not pair an old unfinished break with an unrelated later day's return.
            while (pending.length && event.timestamp.getTime() - pending[0].timestamp.getTime() > 86400000) {
                appendEvent(pending.shift()!);
            }
            const start = pending.shift();
            if (start) appendEvent(start);
            appendEvent(event, start?.branchLocalDate);
        }
        pendingEvents.set(key, pending);
    }
    for (const pending of pendingEvents.values()) for (const start of pending) appendEvent(start);
    for (const list of eventGroups.values()) list.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const snapshotGroups = new Map<string, ReportSnapshot[]>();
    for (const snapshot of snapshots) {
        const id = String(snapshot.employee);
        const list = snapshotGroups.get(id) ?? [];
        list.push(snapshot);
        snapshotGroups.set(id, list);
    }
    if (!report.people.length) {
        summary.addRow(['No records']);
        details.addRow(['No records']);
    }
    for (const person of report.people) {
        const records = [...(snapshotGroups.get(person.employeeId) ?? [])].sort((a, b) =>
            a.date.localeCompare(b.date) || String(a.branch).localeCompare(String(b.branch)));
        const rows = records.map(snapshot => {
            const breaks = reportBreaks(snapshot, eventGroups.get(reportKey(snapshot.employee, snapshot.branch, snapshot.date)) ?? []);
            return { snapshot, breaks, classification: classifyWork(snapshot, breaks) };
        });
        const neededRows = rows.reduce((n, row) => n + 1 + Math.max(0, row.breaks.length - 1) +
            (row.breaks.length === 0 && (row.snapshot.totalBreakMinutes > 0 || row.snapshot.status === 'open_break') ? 1 : 0), 0) || 1;
        assertAttendanceRowCapacity(summary.rowCount + 1, details.rowCount + neededRows);
        const firstDetail = details.rowCount + 1;
        const summaryRow = summary.addRow([person.employeeName, person.branchNames?.length ? person.branchNames.join(', ') : person.branchName ?? '',
            person.punchedInDays, rows.reduce((n, r) => n + r.classification.full, 0),
            rows.reduce((n, r) => n + r.classification.half, 0),
            rows.reduce((n, r) => n + r.classification.lessThanHalf, 0), person.absentDays, null,
            person.missingCheckoutDays, person.excludedIncompleteDays, null]);
        body(summaryRow);
        duration(summaryRow.getCell(8), person.productiveWorkMinutes);
        link(summaryRow.getCell(11), `'Daily details'!A${firstDetail}`, 'View daily log →');
        const back = (row: ExcelJS.Row) => link(row.getCell(22), `'Summary'!A${summaryRow.number}`, '← Back to summary');
        if (!rows.length) {
            const row = details.addRow([person.employeeName, null, 'No records in selected period']);
            body(row, true); back(row);
        }
        for (const { snapshot: s, breaks, classification: c } of rows) {
            const corrected = ['manual', 'correction'].includes(s.generatedBy);
            const final = c.status === 'Present' && Boolean(s.lastCheckOut || s.lastCheckOutAt);
            const row = details.addRow([person.employeeName, new Date(s.date + 'T00:00:00Z'), c.status,
                null, null, null, null, null, null, null,
                timestamp(s.firstCheckInAt, s.firstCheckIn, s.branchTimezone, s.date),
                s.lastCheckOut || s.lastCheckOutAt ? timestamp(s.lastCheckOutAt, s.lastCheckOut, s.branchTimezone, s.date)
                    : (s.firstCheckIn || s.firstCheckInAt ? 'Missing checkout' : 'N/A'),
                c.label, corrected ? 'Manually corrected' : null, corrected ? s.notes ?? null : null,
                (s.breakTotals ?? []).map(b => [b.breakTypeName, b.breakSubtypeName].filter(Boolean).join(' - ') +
                    `: ${b.minutes}m taken, ${b.unusedAllowedMinutes ?? b.overtimeMinutes}m unused allowance, ${b.excessMinutes ?? b.undertimeMinutes}m excess`).join('; ') ||
                    (!breaks.length && s.totalBreakMinutes === 0 && s.status !== 'open_break' ? 'No break taken' : null),
                s.branchTimezone, s.branchName ?? 'Unavailable branch (' + String(s.branch) + ')']);
            body(row, true);
            row.getCell(2).numFmt = 'dd mmm yyyy';
            row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
            [s.requiredWorkMinutes, s.productiveWorkMinutes, s.totalBreakMinutes,
                final ? s.overtimeMinutes : undefined, final ? s.undertimeMinutes : undefined,
                final ? s.breakOvertimeMinutes : undefined, final ? s.breakUndertimeMinutes : undefined]
                .forEach((minutes, i) => duration(row.getCell(i + 4), minutes));
            if (final && s.requiredWorkMinutes > 0 && s.productiveWorkMinutes < s.requiredWorkMinutes) {
                markBelowExpected(row.getCell(5));
            }
            if (final && ((s.breakUndertimeMinutes ?? 0) > 0 ||
                (s.breakTotals ?? []).some(b => b.excessMinutes > 0))) {
                markBelowExpected(row.getCell(6));
            }
            // Never present unfinished productive/break values as final hours.
            if (!final && !['absent', 'off_day'].includes(s.status)) {
                row.getCell(5).value = 'N/A';
                if (s.status === 'open_break' || breaks.some(b => b.missingEnd)) row.getCell(6).value = 'N/A';
            }
            const fill = c.full ? 'FFE1F3E8' : c.half ? 'FFFFF1CC' : c.label.includes('Missing') ? 'FFFDE8E7' : 'FFEAF0F6';
            row.getCell(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
            back(row);
            if (s.firstCheckIn || s.firstCheckInAt) {
                if (!s.lastCheckOut && !s.lastCheckOutAt) markBelowExpected(row.getCell(12));
            }
            for (const [index, b] of breaks.entries()) {
                const breakRow = index === 0 ? row : details.addRow([]);
                if (index !== 0) body(breakRow);
                const name = [b.breakTypeName, b.breakSubtypeName].filter(Boolean).join(' - ') || 'Break';
                if (index !== 0) breakRow.getCell(16).value = name;
                if (b.missingStart || b.missingEnd) {
                    const message = b.missingEnd ? 'Break-out not recorded' : 'Break-in not recorded';
                    breakRow.getCell(16).value = index === 0
                        ? [row.getCell(16).value, `${name}: ${message}`].filter(Boolean).join('; ')
                        : `${name}: ${message}`;
                    markBelowExpected(breakRow.getCell(16));
                } else if (index === 0 && !row.getCell(16).value) breakRow.getCell(16).value = name;
                breakRow.getCell(19).value = b.missingStart ? 'Break-in not recorded' : timestamp(b.startAt, b.startLocalTime, s.branchTimezone, s.date);
                breakRow.getCell(20).value = b.missingEnd ? 'Break-out not recorded' : timestamp(b.endAt, b.endLocalTime, s.branchTimezone, s.date);
                if (b.missingStart) markBelowExpected(breakRow.getCell(19));
                if (b.missingEnd) markBelowExpected(breakRow.getCell(20));
                if (!b.missingStart && !b.missingEnd) duration(breakRow.getCell(21), b.minutes);
            }
            if (!breaks.length && (s.totalBreakMinutes > 0 || s.status === 'open_break')) {
                const unavailable = details.addRow([]);
                unavailable.getCell(16).value = 'Historical break details unavailable';
                unavailable.getCell(19).value = 'Unavailable';
                unavailable.getCell(20).value = s.status === 'open_break' ? 'Break-out not recorded' : 'Unavailable';
                body(unavailable);
                if (s.status === 'open_break') markBelowExpected(unavailable.getCell(20));
            }
        }
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}
