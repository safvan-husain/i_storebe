# Finalize Inactive Manager Branch Mapping

This migration assigns historical manager groups to explicit branch names from the handwritten mapping and places test-only managers into `Test Branch`.

## Script

```bash
npm run finalize:mapped-branches -- --dry-run
npm run finalize:mapped-branches -- --apply
```

## Branch Names Used

- `Taliparamba`
- `Mattannur`
- `Kannur`
- `Iritty`
- `19th Mile`
- `Payyannur`
- `Call Center`
- `Accounts`
- `HR`
- `Dubai Store`
- `Test Branch`

## Behavior

- Creates each mapped branch if missing.
- Uses one manager as the live branch manager and records additional mapped managers through `BranchMembership` as manager-role members.
- Attaches legacy staff using the existing `User.manager` links.
- Does not rewrite `User.manager` for those staff.
- Keeps admin users outside branches.

## Run Order

For a clean historical rebuild:

```bash
npm run finalize:mapped-branches -- --apply
npm run backfill:branch-snapshots -- --apply --force
```
