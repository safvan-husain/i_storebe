# Attendance Configuration Simplification Plan

## Status

Implemented in code. Production data migration remains dry-run first and must be
reviewed before running with `--apply`.

Legacy attendance configuration endpoints remain unchanged for older clients.
The simplified client uses separate `/attendance/configuration/shifts` and
`/attendance/branch-schedules/...` endpoints.

## Objective

Simplify attendance configuration for admins and branch managers while retaining the existing internal records needed for effective dating and historical attendance calculations.

The normal UI should expose only:

- active shifts
- current branch schedules
- current schedule-group splits
- upcoming scheduled changes

Inactive, expired, and superseded shifts, templates, and assignments remain in the database but are hidden from normal configuration screens.

## User-Facing Areas

### Shifts

Shifts remain a separate admin-managed catalog.

Admins can:

- create and edit shift rules
- choose which branches may use each shift
- view only active shifts by default

Branch managers can:

- select active shifts available to their branch
- not create or edit shift definitions
- not see or select shifts unavailable to their branch

### Branch Schedules

Admins and managers use the same resolved schedule workflow.

Admins select a branch first. Managers open directly into their own branch.

The screen shows:

- the current branch-wide schedule, if present
- whether the branch is split into schedule groups
- each group's current weekly schedule and member count
- employees not covered by an assigned group
- upcoming branch or group schedule changes

Templates and assignments are internal implementation details and are not managed as separate user-facing sections.

## Shift Branch Coverage

### Data Model

Every shift stores an explicit list of branches allowed to use it:

```ts
branchIds: Types.ObjectId[];
```

There is no global shift option.

A shift must include at least one active branch.

### Include and Exclude UI

The Flutter form provides two selection modes:

- `Include branches`
- `Exclude branches`

These modes are only selection conveniences. The database always stores the final included branch IDs.

Examples:

- Including CERTIVO and ACCOUNTS stores exactly those two branch IDs.
- Excluding Branch 1 and Branch 2 resolves all other currently selectable branches and stores those IDs.
- A branch created later is not automatically added to an existing shift.

The API payload contains only the final included IDs:

```json
{
  "name": "10 AM to 9 PM",
  "branchIds": ["branch-a", "branch-b"],
  "startTime": "10:00",
  "endTime": "21:00",
  "requiredWorkMinutes": 600
}
```

Do not store `include`, `exclude`, or a selection-mode field.

### Shift Validation

- `branchIds` must contain at least one active branch.
- Duplicate branch IDs are rejected or normalized.
- Admins can change shift branch coverage.
- Managers receive only active shifts containing their current branch ID.
- Inactive shifts never appear in normal selectors.
- The backend rejects a template or schedule containing an inactive shift.
- The backend rejects a shift not available to the target branch.
- Removing a branch from a shift is blocked while that branch has a current or upcoming schedule using the shift, unless the operation also supplies a valid replacement.

## Schedule Groups

### Corrected Data Model

Every schedule group belongs to exactly one branch:

```ts
branch: Types.ObjectId;
```

There are:

- no global groups
- no branchless groups
- no multi-branch groups

The group branch is required when the group is created.

### Group Permissions

Admins can:

- create a group for one selected branch
- rename or deactivate the group
- manage members from that branch
- configure the group's schedule

Branch managers can:

- see groups belonging to their own branch
- manage their branch employees within those groups
- apply allowed shifts to those groups
- not create cross-branch groups
- not add employees from another branch
- not change the group's owning branch

### Group Validation

- `branch` is required and must reference an active branch at creation time.
- Every group member must currently belong to the group's branch.
- A user can have at most one current schedule-group membership for a branch.
- Moving a user to another group closes the previous membership at the approved effective boundary.
- Changing a group's branch is not supported. Create a new group instead.
- Removing or deactivating a group requires handling its current members and upcoming schedule assignments.

The include/exclude branch selector is not used for groups because a group has exactly one branch.

## Unified Schedule Command

The frontend should submit a resolved scheduling intent instead of separately creating templates and assignments.

Example:

```json
{
  "branchId": "branch-id",
  "targetType": "group",
  "targetId": "group-id",
  "effectiveFrom": "2026-08-01",
  "weeklyPattern": {
    "monday": "shift-id",
    "tuesday": "shift-id",
    "wednesday": "shift-id",
    "thursday": "shift-id",
    "friday": "shift-id",
    "saturday": "shift-id",
    "sunday": null
  }
}
```

The backend atomically:

1. validates the target branch or group
2. validates every selected shift against the branch
3. reuses or creates the required internal template
4. creates the effective-dated assignment
5. supersedes the previous assignment at the correct boundary
6. preserves existing historical records
7. returns the resolved current and upcoming schedule state

## Visibility Rules

Normal admin and manager screens show:

- active shifts available to the selected branch
- current effective branch and group schedules
- current group memberships
- upcoming scheduled changes

Normal screens hide:

- inactive shifts
- inactive templates
- expired templates or assignments
- superseded assignments
- previous versions
- change history and change author
- internal template and assignment identifiers

No history screen is required for admins or managers. Historical records remain available internally for attendance calculations and operational recovery.

## Effective-Date Rules

- Schedule changes default to the next branch-local day.
- Same-day changes are not allowed through the normal UI.
- Existing daily attendance snapshots retain their captured calculation basis.
- Upcoming changes are visible and can be edited or cancelled before becoming effective.
- Only one current schedule assignment may exist for a given branch or group target.
- The first version should allow at most one upcoming change per target to keep behavior understandable.

## API Plan

### Shift APIs

```http
GET /attendance/configuration/shifts?branchId=:branchId&selectable=true
POST /attendance/configuration/shifts
PATCH /attendance/configuration/shifts/:id
```

`/attendance/shifts` and `/attendance/shifts/:id` retain their legacy behavior.

Shift create and update payloads use explicit `branchIds`.

For managers, the backend derives their branch from authentication and does not trust a caller-supplied branch ID.

### Resolved Schedule APIs

```http
GET /attendance/branch-schedules/:branchId
PUT /attendance/branch-schedules/:branchId
PUT /attendance/branch-schedules/:branchId/groups/:groupId
DELETE /attendance/branch-schedules/upcoming/:changeId
```

### Group APIs

```http
GET /attendance/configuration/schedule-groups?branchId=:branchId
POST /attendance/configuration/schedule-groups
PATCH /attendance/configuration/schedule-groups/:id
PUT /attendance/configuration/schedule-groups/:id/members
```

The original `/attendance/schedule-groups/...` routes remain available with
their legacy behavior for existing clients.

## Flutter Plan

Create one reusable shift-coverage component for admin shift forms:

```dart
BranchCoverageSelector(
  branches: activeBranches,
  includedBranchIds: selectedBranchIds,
  onChanged: onIncludedBranchesChanged,
)
```

It supports:

- include mode
- exclude mode
- branch search
- select all
- clear all
- final included-branch count
- final included-branch preview

The component always emits the final included branch IDs.

Create one branch-schedule screen shared by admins and managers:

- admins receive a branch selector
- managers are locked to their own branch
- current branch and group schedules appear as cards
- upcoming changes appear separately
- schedule editing uses one bottom sheet
- group-member management remains available from each group card

## Data Migration

Commands:

```sh
# Inventory only. This is the default and writes nothing.
npm run migrate:attendance-configuration -- --dry-run

# Apply only after every ambiguity in the dry-run report is resolved.
npm run migrate:attendance-configuration -- --apply

# Preview or apply rollback using the backup emitted by the apply command.
npm run rollback:attendance-configuration -- --backup=/absolute/path/to/backup.json
npm run rollback:attendance-configuration -- --backup=/absolute/path/to/backup.json --apply
```

1. Add `branchIds` to the shift model and indexes.
2. Inventory every active shift, template, assignment, and target branch.
3. Derive initial shift branch coverage from current and upcoming effective usage.
4. Flag shifts used by multiple branches for manual confirmation.
5. Do not infer coverage from shift names alone.
6. Backfill every shift with an explicit non-empty `branchIds` list.
7. Ensure every schedule group has exactly one valid branch.
8. Manually resolve branchless legacy groups; do not assign them to all branches automatically.
9. Reject or manually split any unexpected multi-branch legacy group data.
10. Validate every current and upcoming template against the selected shifts' branch coverage.
11. Correct incompatible references before enabling strict backend validation.
12. Deploy backend read filtering and write validation.
13. Deploy the unified Flutter screens after backend enforcement is active.
14. Keep legacy fields temporarily for rollback, then remove them after verification.

## Verification

- Every shift has a non-empty, unique list of valid branch IDs.
- Every group belongs to exactly one branch.
- No branchless or multi-branch group remains.
- Admins can use include or exclude mode and the database stores only final included branch IDs.
- New branches are not silently added to existing shifts.
- Managers see only active shifts available to their branch.
- Managers cannot submit another branch's shift directly to the API.
- Inactive shifts do not appear and cannot be selected.
- Group members all belong to the group's branch.
- Admins can see whether a branch uses one schedule or multiple group schedules.
- Managers see the same resolved state for their own branch.
- Current and upcoming schedule changes are visible.
- Inactive and superseded internal records are hidden.
- Existing attendance snapshots retain their historical calculation basis.
- Branch and group schedule updates are atomic.

## Rollback Requirements

Before migration, capture all affected shift, group, membership, template, and assignment documents.

Rollback must be able to:

1. restore original shift scope fields
2. restore original group branch fields
3. restore any corrected template and assignment references
4. remove only records created by the new unified schedule commands
5. restore the previous Flutter/API workflow while preserving attendance snapshots

## Implementation Requirement

Implementation must be staged backend-first, support a dry-run migration, stop on ambiguous branch coverage, and never rewrite historical attendance snapshots or their captured calculation basis.
