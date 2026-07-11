# Cleanup Attendance Data

## Status

Planning only. Do not apply this migration until it has been reviewed and explicitly approved.

This runbook describes the data changes needed to:

- leave the people associated with `Branch 1` and `Branch 2` without a branch
- move the people associated with `HR` to `KANNUR HEAD OFFICE`
- preserve historical branch-membership records for audit purposes
- classify attendance shifts as global or branch-specific and restrict manager selection accordingly
- remove the unused duplicate `NADEER 19` account while preserving the active `Nadeer 19th mile` account

## Source Data

The following records were found in the production backup created on July 11, 2026.

### Branch 1

- Branch ID: `6a08c6b590cfc502e83917cf`
- Branch status: inactive
- Manager: `AFNAS AV` (`68724e0b889dda170d693f65`, active)
- Current embedded staff: none
- Former staff: `NAFIH` (`688f5455889dda170d70712e`, inactive)
- NAFIH's membership already ended on July 9, 2026

Expected result:

- AFNAS AV has no current branch assignment.
- NAFIH remains without a current branch assignment.
- Existing historical memberships remain stored, with no open membership for either user.

### Branch 2

- Branch ID: `6a08c6b690cfc502e83917f1`
- Branch status: inactive
- Manager: `AFREED` (`69a9620b8c8282c866d1623b`, inactive)
- Staff: `Sreenanth PP` (`69b7a3758c8282c866d214e8`, inactive)

Expected result:

- AFREED has no current branch assignment.
- Sreenanth PP has no current branch assignment.
- Their open `BranchMembership` records are ended rather than deleted.

### HR

- Branch ID: `6a08c6601e1885f4145eb6a3`
- Branch status: inactive
- Manager: `AFREED HR` (`69a962b08c8282c866d16270`, active)
- Staff: `SAFANA` (`69a962fc8c8282c866d162a6`, inactive)

Target branch:

- Branch: `KANNUR HEAD OFFICE`
- Branch ID: `6a2102a95df4ac9a578785a5`

Expected result:

- AFREED HR becomes a member of KANNUR HEAD OFFICE.
- SAFANA becomes a member of KANNUR HEAD OFFICE even though the user is inactive, unless this is rejected during review.
- Their open HR memberships are ended rather than deleted.
- KANNUR HEAD OFFICE's existing manager is not replaced.

### 19TH MILE schedule groups

Branch:

- Branch: `19TH MILE`
- Branch ID: `6a08c65f1e1885f4145eb591`

Rename and scope the existing groups instead of creating duplicate group records:

- Rename `test` (`6a0ee6c8a1434d9c2605430d`) to `19th Mile Group 1`.
- Rename `test-2` (`6a0ee689a1434d9c260542ea`) to `19th Mile Group 2`.
- Set both groups' branch scope to `19TH MILE` (`6a08c65f1e1885f4145eb591`).
- Preserve their existing schedule assignments and effective dates.

Current active 19TH MILE roster:

- `Abhijith Mngr` (`686a4a5e6feea51edf8d2cf2`, manager) is currently in `test`; retain in `19th Mile Group 1`.
- `Nadeer 19th mile` (`69b7a9068c8282c866d215b0`, staff) is currently in `test-2`; retain in `19th Mile Group 2`.
- `SAIFUDHEEN` (`6a4761235c07f1cf65bb6dc4`, staff) is not currently in either group; add to `19th Mile Group 1`.

Remove stale active group memberships:

- Remove `SHAMIL 19TH MILE` (`6948165a06ea855a1268fde6`) from `test`. The user is inactive and the 19TH MILE branch membership ended on July 9, 2026.
- Remove `IRFAN LK` (`6a09cde6447993297e792e86`) from `test-2`. The user is active, but the 19TH MILE branch membership ended on July 9, 2026.
- End these group memberships rather than deleting their historical records.

No action is required for `devaj` (`67f618785281197161debf7c`) because the `test` group membership is already closed.

`NADEER 19` (`68c14136f3a7510bc25d5a5f`) is still present in the branch's embedded staff list but is inactive and is not a member of either schedule group. Review this stale branch reference separately; do not add the user to either group.

### Duplicate NADEER account

Account to remove:

- Username: `NADEER 19`
- User ID: `68c14136f3a7510bc25d5a5f`
- Status: inactive
- Leads created, managed, or handled: 0
- CRM activities: 0
- Tasks created or assigned: 0
- Login-history records: 0
- Attendance events: 0

Account to preserve:

- Username: `Nadeer 19th mile`
- User ID: `69b7a9068c8282c866d215b0`
- Status: active
- This account has login and attendance history and must remain unchanged.

Expected result:

- Remove the inactive `NADEER 19` duplicate after confirming that no other collection contains business or audit references to it.
- Preserve the active `Nadeer 19th mile` account and all associated records.

## Decisions Required Before Implementation

- Confirm that AFNAS AV should be left active while having no branch.
- Confirm that inactive users AFREED and Sreenanth PP should remain inactive and branchless.
- Confirm whether inactive user SAFANA should actually be moved to KANNUR HEAD OFFICE or only have the old HR membership closed.
- Confirm the KANNUR HEAD OFFICE membership role for AFREED HR. The existing KANNUR HEAD OFFICE manager must remain unchanged.
- Confirm whether `Branch 1`, `Branch 2`, and `HR` should remain as inactive historical branch records or be deleted after references are cleared. Keeping them is safer for historical reporting.
- Confirm the scope of every attendance shift: either `global` or one specific branch. The recommended default is branch-specific; use global only when the same shift is intentionally shared by all branches.
- Confirm whether `NADEER 19` should be hard-deleted or processed through the application's standard account-deletion or anonymization workflow.

## Shift Scope Cleanup

Current behavior:

- Shift definitions have no branch ownership or scope.
- A branch manager receives the complete organization-wide shift list.
- A manager can select a shift created for another branch when building a weekly template.
- Inactive shifts are also returned and can appear in the manager's shift selector, although schedule resolution ignores inactive shifts.

Required behavior:

- Every shift must have either global scope or one owning branch.
- Admins can create and manage global shifts and branch-specific shifts.
- A branch manager can select active global shifts and active shifts owned by their own branch.
- A branch manager cannot select or discover shifts owned by another branch.
- Inactive shifts must not appear in selectors and must be rejected if submitted directly to the API.
- Existing templates and historical attendance calculation bases must retain enough shift information for historical reporting.

Recommended migration policy:

- Assign a shift to a branch when its current active template usage belongs to one branch.
- Keep a shift global only when it is intentionally used by multiple branches.
- Review shared shifts manually before marking them global; shared usage may be accidental legacy reuse.
- Do not infer scope from the shift name alone.

## Migration Tasks

1. Take a fresh production backup and record its filename and creation time.
2. Run the migration in dry-run mode against a restored copy of that backup.
3. Verify the IDs and current state of all six affected users before applying changes.
4. Check whether any affected user has another current branch membership that must not be overwritten.
5. Check references from attendance snapshots, events, schedules, reports, tasks, customers, and other branch-linked collections.
6. Remove AFNAS AV from the current manager position of Branch 1 without deleting historical membership records.
7. Ensure NAFIH has no open Branch 1 membership. Do not alter the already closed historical membership.
8. Remove AFREED and Sreenanth PP from Branch 2's current manager/staff fields.
9. End any open Branch 2 memberships for AFREED and Sreenanth PP using one consistent effective timestamp.
10. Remove AFREED HR and SAFANA from HR's current manager/staff fields.
11. End their open HR memberships using the same effective timestamp used for their move.
12. Add AFREED HR to KANNUR HEAD OFFICE without replacing its existing manager.
13. Add SAFANA to KANNUR HEAD OFFICE only if the inactive-user decision above is approved.
14. Create new KANNUR HEAD OFFICE membership-history records for each moved user.
15. Update legacy `User.manager` links where required so they do not continue pointing to managers from the removed branch structure.
16. Recalculate or refresh dependent branch caches only where the application normally requires it.
17. Leave historical attendance events and snapshots attached to their original branches unless a separate historical-data migration is explicitly approved.
18. Inventory every shift and list all active templates and effective assignments that reference it.
19. Decide whether each shift is global or owned by one specific branch.
20. Add the approved scope to each shift without changing its hours, required work minutes, grace periods, version history, or active state.
21. Flag shifts referenced by multiple branches for manual review instead of automatically treating them as global.
22. Update manager-facing shift queries to return only active global shifts and active shifts owned by the manager's branch.
23. Add backend validation so managers cannot place another branch's shift or an inactive shift into a schedule template.
24. Preserve existing snapshot calculation bases and historical attendance records without rewriting their captured shift data.
25. Rename `test` to `19th Mile Group 1` and set its branch scope to 19TH MILE.
26. Rename `test-2` to `19th Mile Group 2` and set its branch scope to 19TH MILE.
27. Retain Abhijith Mngr in Group 1 and Nadeer 19th mile in Group 2.
28. End SHAMIL 19TH MILE's Group 1 membership and IRFAN LK's Group 2 membership without deleting history.
29. Add SAIFUDHEEN to `19th Mile Group 1` so the existing later-shift assignment applies.
30. Preserve both existing group schedule assignments and their effective dates.
31. Remove the inactive `NADEER 19` user from the branch's current embedded staff list without rewriting historical branch membership.
32. Search every collection for references to user ID `68c14136f3a7510bc25d5a5f`, including branches, memberships, leads, activities, tasks, login history, attendance, reports, notifications, files, and audit records.
33. Stop for manual review if any unexpected reference to `NADEER 19` is found.
34. Remove or anonymize only the inactive `NADEER 19` account using the approved account-deletion policy.
35. Do not modify `Nadeer 19th mile` (`69b7a9068c8282c866d215b0`) or any records associated with that active account.

## Verification Checklist

- Branch 1 has no current manager or staff references to AFNAS AV or NAFIH.
- Branch 2 has no current manager or staff references to AFREED or Sreenanth PP.
- AFNAS AV, NAFIH, AFREED, and Sreenanth PP have no open branch memberships.
- HR has no current manager or staff references to AFREED HR or SAFANA.
- AFREED HR has exactly one open membership in KANNUR HEAD OFFICE.
- SAFANA has the approved target state: one KANNUR HEAD OFFICE membership or no open membership.
- KANNUR HEAD OFFICE's existing manager is unchanged.
- No affected user has multiple open branch memberships.
- Historical membership records still exist and have correct end timestamps.
- Historical attendance records retain their original branch references.
- Attendance configuration and branch employee lists show the expected state.
- Every shift has exactly one valid scope: global or one branch.
- Managers can see active global shifts and active shifts owned by their branch.
- Managers cannot see or submit another branch's shift.
- Inactive shifts do not appear in manager selectors and are rejected by the backend.
- Existing active templates reference shifts allowed for their branch, or are listed for manual correction.
- Historical attendance snapshots still resolve their captured calculation basis after shift scoping.
- `test` no longer exists as a group name; its record is now `19th Mile Group 1` and is scoped to 19TH MILE.
- `test-2` no longer exists as a group name; its record is now `19th Mile Group 2` and is scoped to 19TH MILE.
- Group 1 contains only approved current 19TH MILE users and retains its existing schedule assignment.
- Group 2 contains only approved current 19TH MILE users and retains its existing schedule assignment.
- SHAMIL 19TH MILE and IRFAN LK have no open membership in either 19TH MILE schedule group.
- SAIFUDHEEN has exactly one open membership in `19th Mile Group 1` and resolves to its existing later-shift assignment.
- No user outside the current active 19TH MILE roster has an open membership in either group.
- `NADEER 19` (`68c14136f3a7510bc25d5a5f`) is removed or anonymized according to the approved policy and is absent from the current 19TH MILE staff list.
- No unexpected dangling reference remains for the removed duplicate account.
- `Nadeer 19th mile` (`69b7a9068c8282c866d215b0`) and all login and attendance records remain unchanged.

## Rollback Plan

Before applying the migration, capture the complete affected branch, user, and membership documents. A rollback must:

1. Restore the original manager and staff arrays on Branch 1, Branch 2, and HR.
2. Reopen only the memberships that were closed by this migration.
3. End or remove only the KANNUR HEAD OFFICE memberships created by this migration.
4. Restore any `User.manager` values changed by this migration.
5. Verify that no unrelated KANNUR HEAD OFFICE membership was modified.
6. Restore the original `test` and `test-2` names and organization-wide scopes if the 19TH MILE group cleanup is rolled back.
7. Reopen only the stale group memberships ended by this migration.
8. End or remove only the SAIFUDHEEN group membership created by this migration.
9. Restore the duplicate account and its 19TH MILE branch reference from the pre-migration backup if the account cleanup is rolled back.

## Implementation Requirement

The eventual migration script must support `--dry-run` and `--apply`, print a before/after summary, use a transaction where supported, and stop if the production records no longer match the source state documented above.
