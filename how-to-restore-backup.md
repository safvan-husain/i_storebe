# How To Restore The MongoDB Backup For Docker Development

This restore flow is only for the local Docker development MongoDB. Do not use it against production.

The backup archive is expected at:

```text
/Users/safvanhusain/code/hashqubes/istore/mongodb-backup-2026-10-15T11-08-27-973640.archive.gz
```

## First Boot Default

Compose restores the archive automatically when it creates a new local MongoDB volume. Existing volumes are not overwritten on restart.

## 1. Start MongoDB

From the `backend` directory:

```bash
docker compose -f docker-compose.dev.yml up -d mongo
```

Check that MongoDB is healthy:

```bash
docker compose -f docker-compose.dev.yml ps
```

## 2. Restore The Backup

Run the restore service manually:

```bash
docker compose -f docker-compose.dev.yml --profile restore run --rm mongo-restore
```

This command:

- connects only to the Docker Compose MongoDB service at `mongodb://mongo:27017`
- reads the backup archive as read-only from `/backup/archive.gz`
- restores only `i-store-db.*`
- uses `--drop`, so matching local Docker collections are deleted and recreated from the backup

Restarting MongoDB does not refresh an existing volume. Run the explicit restore above when switching archives. Both Compose mounts must point to the same archive.

## 3. Verify The Restore

List restored collections:

```bash
docker compose -f docker-compose.dev.yml exec mongo mongosh i-store-db --eval "show collections"
```

Check key collection counts:

```bash
docker compose -f docker-compose.dev.yml exec mongo mongosh i-store-db --quiet --eval 'print(db.users.countDocuments() + " users, " + db.leads.countDocuments() + " leads, " + db.activities.countDocuments() + " activities")'
```

## 4. Start The Backend

Create a local Docker env file if you have not already:

```bash
cp .env.docker.example .env.docker
```

Fill `.env.docker` with development-safe Firebase/email values, then start the backend and MongoDB:

```bash
docker compose -f docker-compose.dev.yml up --build
```

The API should be available at:

```text
http://localhost:4000/
```

## Production Warning

Do not use this Docker setup in production. Production should continue to use the PM2 deployment flow with `npm run build`, `pm2`, and `ecosystem.config.js`.


## Attendance Excel HTTP export

An authenticated admin or HR user can download:

```text
GET /api/attendance/reports/export?from=2026-10-01&to=2026-10-15
Authorization: Bearer <token>
```

Optional filters: `employeeId`, `branchId`, and `excludeWithoutSnapshots=true`.
The response is an XLSX attachment with Summary and Daily details sheets.
Export reads existing snapshots and events; it does not finalize or regenerate attendance.

For restored-production-data verification, run the imported Express app in `NODE_ENV=test`
with an explicit local MongoDB connection and development JWT secret. This skips the normal
bootstrap, scheduled jobs and outbound messaging; do not run background jobs using restored
production contacts. Do not point the test runner at a production URI.

## Flutter export and historical branches

The Flutter export dialog starts with the current browsing filters, but edits affect only
the downloaded workbook. Both export entry points use the backend endpoint; local Flutter
workbook builders are deprecated. Existing JSON endpoints remain active for old apps.

Excel branch selection follows stored daily snapshots, including former staff and inactive
historical branches. Summary lists all branches in the range; Daily details includes the
branch recorded for each day. Current members without snapshots remain as explicitly empty
rows unless excluded. The legacy on-screen JSON summary retains its current-membership
policy, so a branch Excel export may include historical staff absent from that screen.
