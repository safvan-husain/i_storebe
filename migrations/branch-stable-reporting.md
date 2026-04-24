# Branch-Stable Reporting Migration

## Purpose

This migration changes reporting from live manager/staff relationships to stored branch snapshots.

Baseline old-code commit before this migration work:

```text
ef67342261b6ba05018f4fa85b164e0ca658d141
```

Commit summary:

```text
ef67342 refactor
2026-04-23 16:21:55 +0530
```

Before this change, targets, lead counts, wins, and activity reports were mostly derived from the current `User.manager` relationship. That created incorrect historical reports when a staff member or manager moved branches. Old activity and wins could appear under the new branch, while the original branch lost those numbers.

The new model stores branch context at the time work happens and keeps branch membership history. Reports can now include users who worked in a branch during a period even if they later transferred away.

## New Data Model

### Lead branch snapshots

`Lead` now stores:

- `createdBranch`: branch where the lead was created.
- `handlingBranch`: branch currently responsible for the lead.
- `wonBranch`: branch that closed the lead.
- `wonBy`: user who marked the lead as won.

Existing fields are still kept:

- `createdBy`
- `handledBy`
- `manager`

These existing fields are still useful for compatibility and current access behavior, but historical reports should prefer the branch snapshot fields.

### Activity branch snapshot

`Activity` now stores:

- `actorBranch`: branch of the user who performed the activity.

New activities automatically resolve `actorBranch` from the current branch of `activator`.

This means an activity remains attached to the branch where it happened, even if the actor later transfers.

### Branch membership history

New collection:

```text
branchmemberships
```

Fields:

- `branch`
- `user`
- `role`: `manager` or `staff`
- `startedAt`
- `endedAt`
- `startedBy`
- `endedBy`
- `endReason`: `transferred`, `removed`, `manager_changed`, or `branch_inactivated`

The live branch view still exists in `Branch.manager`, `Branch.staffs`, and `User.manager`. Membership history is the historical reporting source.

## Branch Mutation Behavior

Branch create, update, staff add, staff remove, and staff transfer now update `BranchMembership`.

Expected behavior:

- Creating a branch opens memberships for the manager and initial staff.
- Adding staff opens staff memberships.
- Moving staff closes their old open branch membership as `transferred` and opens a new one.
- Removing staff closes their branch membership as `removed`.
- Changing a manager closes the old manager membership as `manager_changed` and opens the new manager membership.

## Target Behavior

`Target` now supports three scopes:

- `legacy`: old user target behavior.
- `branch`: official branch-month target.
- `allocation`: per-user target allocation inside a branch target.

Fields added to `Target`:

- `scope`
- `branch`
- `parentTarget`

### Old frontend payload with manager assigned

When the old frontend sends:

```json
{
  "assigned": "<managerId>",
  "total": 25,
  "month": 123456789
}
```

The backend now behaves as follows:

- If the assigned user is a manager and owns a branch, update the branch target.
- Do not create a legacy manager target in that case.
- If the manager has no branch, fall back to legacy manager target creation.

This preserves old frontend compatibility while making manager target assignment branch-based.

### Old frontend payload with staff assigned

When the assigned user is staff:

- If the staff belongs to a branch, create or update an `allocation` target for that branch and staff.
- Keep the old `legacy` staff target for compatibility.

### New branch target payload

New payloads can send `branch` or `branchId` directly.

The backend will:

- create or update the branch target
- create or update allocation rows if `allocations` are provided

Example shape:

```json
{
  "branch": "<branchId>",
  "month": 123456789,
  "total": 100,
  "allocations": [
    { "assigned": "<managerOrStaffId>", "total": 40 },
    { "assigned": "<staffId>", "total": 60 }
  ]
}
```

## Achievement Rules

### Normal lead won

When a lead becomes `won`:

- credit the user who marked it won
- credit that user's `wonBranch`
- create or update allocation rows if needed

### Call-center-created transferred lead won

If a lead was created by a call-center staff and later won by another user:

- credit the call-center creator
- credit the creator's `createdBranch`
- credit the closer
- credit the closer's `wonBranch`

If creator and closer are the same user, credit only once.

### Removing won status

When `won` is removed:

- decrement the same users and branches that were credited
- use stored `wonBy`, `wonBranch`, and `createdBranch`
- do not derive decrement targets from current branch membership

## Activity Reporting Behavior

Activity reports can now filter by branch.

Branch activity reports use:

- `Activity.actorBranch` for actual activity attribution
- `BranchMembership` overlap for row inclusion

This is important for transferred users. If a user worked in a branch during a selected month and later moved away, that user should still appear in that branch report with transferred/removed status so totals do not look incorrect.

## Target Reporting Behavior

Branch target reports include rows from:

- current branch manager and staff
- allocation targets for the selected month
- branch membership records that overlap the selected month
- achieved rows created by wins

Rows can include:

- `membershipStatus: active`
- `membershipStatus: transferred`
- `membershipStatus: removed`

This prevents branch totals from showing numbers that cannot be explained by the visible employee rows.

## Backfill Script

Script:

```bash
npm run backfill:branch-snapshots
```

Default mode is dry-run.

Equivalent dry-run command:

```bash
npm run backfill:branch-snapshots -- --dry-run
```

Apply mode:

```bash
npm run backfill:branch-snapshots -- --apply
```

Force overwrite mode:

```bash
npm run backfill:branch-snapshots -- --apply --force
```

### What the backfill does

The script builds a user-to-branch map from current `Branch.manager` and `Branch.staffs`.

For existing leads:

- `createdBranch` comes from `createdBy`
- `handlingBranch` comes from `handledBy`
- fallback order is `handledBy`, then `manager`, then `createdBy`
- `wonBranch` is set from `handlingBranch` only when the lead is currently `won`

For existing activities:

- `actorBranch` comes from `activator`

For existing branch memberships:

- create open memberships for current branch managers and staff
- use branch `createdAt` as `startedAt` when exact assignment date is unknown

### Dry-run output

The script prints a JSON summary with:

- mode
- branch count
- user-to-branch mappings
- memberships to create
- leads to update
- unresolved lead ids
- activities to update
- unresolved activity ids

Review dry-run output before using `--apply`.

## Consequences

### Historical accuracy

Reports after this deployment become branch-stable.

Existing historical data can only be backfilled using current branch membership. If a user transferred before branch membership history existed, the exact old branch assignment cannot be reconstructed unless there is reliable external data.

### Old target data

Old user target documents are not deleted.

New reporting should prefer:

- branch targets for branch totals
- allocation targets for employee splits

Legacy target rows remain for compatibility and fallback.

### Old frontend compatibility

The current frontend can continue sending old `assigned` target payloads.

Manager assignment now maps to branch target when possible. Staff assignment maps to allocation target when possible.

A future frontend update is still useful for:

- explicit branch target creation
- allocation editing
- displaying transferred/removed users in reports
- branch-based filters

### Report interpretation

A transferred user in a branch report means:

```text
The user belonged to or contributed to this branch during the selected period,
but is not currently assigned to this branch.
```

This is expected and prevents mismatched totals.

## Verification

The following checks were run after implementation:

```bash
npm run build
npm run test:e2e
```

The e2e coverage includes:

- branch membership creation
- staff transfer membership close/open
- branch snapshots on lead creation
- handling branch update on transfer
- call-center creator plus closer target credit
- old manager-assigned target payload mapping to branch target
