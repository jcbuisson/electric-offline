# Offline users and groups

A vanilla-JavaScript directory with offline editing, PostgreSQL persistence, and
real-time Electric sync. PGliteWorker shares one local database across browser tabs.

## Run

Use a PostgreSQL database configured for Electric's logical replication. Set the
API connection explicitly, using your existing database to retain its records:

```sh
export DATABASE_URL='postgresql://localhost/directoryDB'
npm install
npm run dev
```

For a fresh installation, create the database first with `createdb directoryDB`.
The API initializes its tables automatically. Open <http://localhost:5173>.

Electric needs a connection string reachable from inside Docker, including the
credentials for your PostgreSQL installation:

```sh
export ELECTRIC_DATABASE_URL='postgresql://user:password@host.docker.internal:5432/directoryDB'
docker compose up -d electric-directory
```

The API and Electric must connect to the same database. Electric listens on port
3200 and the API on port 3001. Stop any older container occupying port 3200 before
starting this Compose service.

For a production-style run with offline asset caching:

```sh
npm run build
npm start
```

Open <http://localhost:3001>. Keep `DATABASE_URL` set when starting the API.

## Managing records

Users have a first name, last name, and email. Groups have a name, and users can
belong to multiple groups.

Search the Users or Groups list, select a record to edit it, and press Save.
Assign memberships using the checkboxes in a user's editor. Group editors display
their members. Deleting either parent also deletes its memberships. Unsaved form
drafts remain intact during incoming sync updates.

Emails and group names are unique, ignoring case, among active records. A user
requires a first or last name and a valid email. A group requires a name. Failed
changes show the server error: correct the values and save, or use Retry failed
changes after resolving the cause.

The business model follows `workspaces/PORTFOLIO/offline`. Its files and database
are not modified, and its records are not imported automatically.

| Table | Fields |
| --- | --- |
| `app_user` | `id`, `firstname`, `lastname`, `email` |
| `app_group` | `id`, `name` |
| `user_group_relation` | `id`, `user_uid`, `group_uid` |

The parent IDs and membership IDs are UUIDs. A deterministic membership ID makes
concurrent additions of the same user/group pair converge to one relationship.
Memberships can be removed and re-added; delayed edits cannot resurrect deleted
users or groups. Concurrent edits to a record use last-write-wins behavior.

## Sync and multiple tabs

Local writes and their queued mutations commit together. The worker sends queued
changes to the API; `X-Sync-Version` identifies the resulting server version.
Mutations stay queued until Electric delivers that version or a newer one, so
lagging snapshots cannot overwrite unconfirmed local changes.

Parent creates must be acknowledged by the API before memberships are uploaded.
Server deletions retain versioned tombstones, including cascading membership
deletions. Keep these markers so offline clients can confirm their writes.
Foreign keys and parent row locks prevent dangling memberships during concurrent
writes. Local membership reads join against visible parents to tolerate shapes
arriving in different orders.

`sync_client` holds the persistent local client identity. Requests send it through
`X-Sync-Client`, with an increasing `X-Mutation-Revision`. The server stores the
latest revision and response per client/table/record in `directory_mutation_cursor`.
Retries replay the saved result; older requests cannot overwrite newer mutations
from the same client. Keep these receipts to protect against delayed retries.

Only the elected PGlite worker opens the local database and runs Electric and
uploads. BroadcastChannel distributes changes to all tabs. Closing the owning tab
elects a replacement. Every worker preloads its database assets for offline takeover.

New installations use `idb://directory`. An existing sole PGlite database on the
same origin is reused to preserve directory records and pending changes. If the
origin has multiple stores, set `VITE_LOCAL_DATA_DIR` to the desired `idb://` path.
Close all app tabs before reopening after an upgrade so every tab uses the current
worker. Existing PostgreSQL data is retained; this update does not drop databases.

## Code and tests

- `frontend/createLocalDB.js`: shared worker connection and storage selection.
- `frontend/databaseWorker.js`: elected database owner and sync startup.
- `frontend/localSchema.js`, `directorySchema.js`: local queue and directory schema.
- `frontend/directorySync.js`: local edits, uploads, snapshots, and change notifications.
- `frontend/directoryUI.js`: lists, editors, memberships, and failure messages.
- `shared/directoryModels.js`: validation and membership identities.
- `backend/createServerDB.js`, `directorySchema.js`: connection and server schema.
- `backend/directoryRouter.js`, `directoryMutations.js`: versioned mutation API.

Run `npm test` for database and sync checks. Install Chromium once with
`npx playwright install chromium`, then run `npm run test:browser` for offline
editing, cross-tab updates, reconnecting, reload persistence, and offline worker
takeover. Browser tests use isolated storage and mocked remote services.
