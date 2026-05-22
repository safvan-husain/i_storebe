# Backfill Branch Attendance Enabled

This migration sets `attendanceEnabled` on all existing branches so the attendance gate can be controlled per branch instead of by hardcoded branch name.

## Script

```bash
npm run backfill:branch-attendance-enabled -- --dry-run
npm run backfill:branch-attendance-enabled -- --apply
```

## Behavior

- Sets `attendanceEnabled: false` on all branches except `19th Mile`.
- Sets `attendanceEnabled: true` on the branch with normalized name `19th mile`.
- Skips branches that already match the target value.

## Deploy Order

Deploy the backend code first, then run the migration before relying on branch-level attendance settings:

```bash
npm run backfill:branch-attendance-enabled -- --apply
```

Without the migration, `19th Mile` staff would temporarily bypass the attendance gate because missing or false `attendanceEnabled` means bypass.
