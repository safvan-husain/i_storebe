# Provision Branches From Active Managers

## Purpose

This provisioning step creates branches for active managers who do not already own one.

It is intended for the transition from the legacy manager-staff structure to branch-based management. The script reads existing active managers and their linked staff from `User.manager`, creates only missing branches, and leaves existing branches untouched.

## Source Of Truth

The script uses:

- active, non-deleted users with `privilege = manager`
- active, non-deleted staff with `User.manager = <managerId>`
- existing `Branch.manager` assignments to detect managers that already have branches

It does not infer staff from any other source.

## Behavior

Policy:

- create branches only for active managers without a branch
- skip managers who already own a branch
- skip inactive or deleted users
- generate names sequentially as `Branch 1`, `Branch 2`, and so on
- skip names that already exist

Implementation:

- the script reuses `branchService.createBranch()`
- the first active admin user is used as the actor
- `confirmMove: true` is passed so linked manager/staff records can be assigned during migration without manual confirmation

## Commands

Dry-run:

```bash
npm run provision:branches -- --dry-run
```

Apply:

```bash
npm run provision:branches -- --apply
```

Limit rollout:

```bash
npm run provision:branches -- --apply --limit 5
```

Target a single manager:

```bash
npm run provision:branches -- --apply --manager <managerId>
```

## Output

The script prints a JSON summary including:

- total active managers
- managers already with a branch
- managers missing a branch
- branches planned for creation
- generated names
- created branches
- skipped managers
- failures

## Consequences

- Existing branches remain untouched.
- Managers who already have branches are not moved or recreated.
- Staff are attached from the old `User.manager` link at migration time.
- Membership history is created through the normal branch service flow.
- If no active admin exists, the script fails and does nothing.

## Operational Notes

Recommended rollout:

1. Run dry-run and inspect the JSON summary.
2. Verify branch count, missing managers, and generated names.
3. Run apply mode.
4. Verify that the created branch count matches the missing-manager count.
5. Verify manager and staff assignments in the created branches.
