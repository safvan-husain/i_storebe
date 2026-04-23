# How To Restore The MongoDB Backup For Docker Development

This restore flow is only for the local Docker development MongoDB. Do not use it against production.

The backup archive is expected at:

```text
/Users/safvanhusain/code/hashqubes/istore/mongodb-backup-2026-04-23T14-22-08-986899.archive.gz
```

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
