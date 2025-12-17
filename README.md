# TheTrendScope

This repository now includes a minimal server bootstrap that prepares the Supabase schema before serving requests.

## Prerequisites

- Node.js 18+ and npm.
- Environment variables for your Supabase project:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - Optional defaults: `ADMIN_USER` and `ADMIN_PASSWORD` for seeding the `admins` table.

You can place these in a local `.env` file in the project root. The server reads it automatically on startup.

## Running the schema bootstrap locally

Install dependencies and run the bootstrap script:

```bash
npm install
npm run bootstrap
```

The script calls the Supabase SQL API (using the service role key) to idempotently create or update the `videos`, `stats_snapshots`, `notes`, and `admins` tables.

## Starting the server

To run the lightweight HTTP server (it bootstraps the schema first and then begins listening):

```bash
npm install
npm start
```

The server listens on `PORT` (default: `3000`) and returns a simple JSON payload to confirm it is running.
