# 📇 CRM Backend System – Architecture & Features

This document outlines the backend architecture and business logic of a **CRM (Customer Relationship Management)** system designed to manage leads, customers, and employee activities, all within a role-based mobile application.

## Development Docker Setup

This Docker setup is for local development and testing only. It runs the backend with `npm run dev` and a local MongoDB 8.0 container so production backup data can be tested without touching the live production database.

Strict production warning:

- Do not use `Dockerfile.dev` or `docker-compose.dev.yml` in production.
- Production must continue to run without Docker by using the existing PM2 flow: `npm run build`, then PM2 with `ecosystem.config.js`.
- The MongoDB backup archive contains production data. Do not commit it, share it, or restore it anywhere except an isolated local development MongoDB.

### Environment

Copy the example Docker env file and fill in development-safe values:

```bash
cp .env.docker.example .env.docker
```

The Docker Compose file sets these development defaults:

```bash
PORT=4000
MONGODB_URI=mongodb://mongo:27017/i-store-db
```

Firebase credentials are still required because the backend initializes Firebase on startup. Provide one of `FIREBASE_SA_JSON`, `FIREBASE_SA_B64`, or mount a service account file and set `GOOGLE_APPLICATION_CREDENTIALS`. Gmail/OAuth values are also needed if you want the existing email jobs to work in Docker.

### Start Development Services

From the `backend` directory:

```bash
docker compose -f docker-compose.dev.yml up --build
```

The API is exposed at:

```text
http://localhost:4000/
```

MongoDB is exposed locally at:

```text
mongodb://localhost:27017/i-store-db
```

### Restore The Production Backup Into Local Docker MongoDB

The restore is manual by design. Starting Docker will not wipe your local development data.

The expected backup archive is:

```text
/Users/safvanhusain/code/hashqubes/istore/mongodb-backup-2026-04-23T14-22-08-986899.archive.gz
```

To drop and re-import the `i-store-db` collections into the Docker MongoDB service:

```bash
docker compose -f docker-compose.dev.yml --profile restore run --rm mongo-restore
```

This command targets only the Compose MongoDB service at `mongodb://mongo:27017`, reads the archive as read-only, uses `--gzip --archive=/backup/archive.gz`, and uses `--drop` so restored collections replace the existing local Docker copies.

To inspect restored collections:

```bash
docker compose -f docker-compose.dev.yml exec mongo mongosh i-store-db --eval "show collections"
```

---

## 🧩 System Overview

```mermaid
graph TD
subgraph Mobile App
    A1[Admin]
    A2[Manager]
    A3[Staff]
  end
  
subgraph Node.js Backend
    Auth[Authentication Module]
    User[User Module]
    Lead[Lead Module]
    Target[Target Module]
    Customer[Customer Module]
    Activity[Activity Module]
    Task[Task Module]
    Leave[ Leave Module]
    Email[Email Module]
    Push[Push Notification Module]
  end
 A1 --> Auth
  A2 --> Auth
  A3 --> Auth

  Auth --> User
  Auth --> Lead
  Auth --> Target
  Auth --> Leave
  Auth --> Task
  Customer -->|birthday wish| Email
  Lead -->|transfer| Push
  Task --> |transfer| Push
	User -->|create task| Task
  Task --> Activity
  Lead -->|status update| Activity
  Lead --> Customer
  Lead -->|won| Target
  Lead --> Push
```

- **Platform**: Mobile Application (single app for Admin, Manager, Staff)
- **Architecture**: A monolithic Node.js backend, organized in a modular, feature-based structure, with separate route and controller files for each domain (leads, tasks, customers, etc.).
---

## 👥 User Roles & Permissions

### Admin
- Access to **all leads**, **all activity**, **all customer data**
- Can **transfer** leads to any user
- Can **assign monthly targets** to managers
- Can **view and approve leave requests**
- Can **download customer data as Excel**
- Receives **push notifications** for all transfers/tasks
- Can **search** leads, users, customers globally

### Manager
- Can see **their own leads** and **leads of their staff**
- Can **transfer** leads to other managers or staff
- Can assign **monthly targets** to staff
- Can view **all activity** related to a lead, or globally
- Can **create tasks**, update lead status, etc.
- Receives push notifications when assigned leads or tasks

### Staff
- Can only see **leads they created or assigned to**
- Can **transfer** leads to their manager or other staff in same group
- Can update status, create tasks, etc. (recorded as activity)
- Can **submit leave requests** to admin
- Receives push notifications for assigned tasks or lead transfers

---

## 📁 Modules and Features

### 🔑 Authentication Service
- Role-based login (Admin, Manager, Staff)
- JWT/OAuth authentication
- Middleware enriches request with role-based privileges

### 👤 User Service
- Role & hierarchy management
- Staff linked to Manager
- Target assignment tracking

### 📋 Lead Service
- CRUD for leads
- Pagination and search support
- Transfers restricted based on hierarchy
- Auto-log each update as an **activity**

### 🧭 Target Service
- Admin assigns targets to Managers
- Managers assign targets to Staffs
- Monthly breakdown of:
  - Assigned Target
  - Achieved Target (based on leads with status "Won")
- Automatically filters and calculates by role

### 🗂️ Customer Service
- Separate from leads
- Avoids duplication via unique checks (email/phone)
- Admin can export as Excel

### 🛠️ Activity Service
- Every event logs a new activity:
  - Lead transfer
  - Status update
  - Task creation
- Accessible to users based on lead visibility

### 📧 Email Service
- Sends **birthday wishes** using Gmail API (OAuth)
- Daily cron job checks for upcoming birthdays

### 📆 Task & Leave Service
- Tasks can be assigned to staff by managers/admin
- Leave requests submitted by staff → viewed & approved by Admin
- Each action creates a new **activity**

### 🔔 Push Notification Service
- Uses Firebase Cloud Messaging (FCM)
- Sent for:
  - Lead transfer
  - Task assignment

---

## 🔁 Shared API Design

The backend uses **shared routes** for similar operations, such as:
- `GET /leads`
- `POST /leads`
- `POST /transfer`
- `GET /activity`
- `POST /target`

### Role-Based Logic
Each request is filtered and controlled by middleware that attaches the user’s **role and scope**:
```js
req.user = {
  id: "user_id",
  privilege: "admin" | "manager" | "staff",
}
