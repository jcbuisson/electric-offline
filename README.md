# Offline todos

A minimal vanilla-JavaScript todo app. The UI reads and writes PGlite in IndexedDB immediately, queues mutations while offline,
sends them to a small Postgres API when connected, and receives Postgres changes through Electric.


## uid's or server-generated id's?
A server-generated primary key could be used, but a reliable reconciliation with server data would be much more complex.
Using client-generated UUIDs is slighly less performant, but much simpler to manage

## data versions
X-Sync-Version is a custom HTTP response header which tells the client which server version corresponds to its mutation.

For example, after an edit, the API returns:
  HTTP/1.1 200 OK
  X-Sync-Version: 42

The sync code reads it:
  const version = response.headers.get('X-Sync-Version')

Then it stores 42 in the mutation queue’s acknowledged_version.
The local change stays protected until Electric delivers that row with:
  row.version >= acknowledged_version

At that point, the mutation can leave the queue and the remote row can be applied locally.
The header also works for DELETE responses with status 204, which have no response body. Electric delivers the
row’s version separately through its stream; Electric does not read this header.


## Run

With Postgres and Electric already running:

```sh
npm install
npm run dev
```

Open <http://localhost:5173>. The API defaults to the local `todoDB` database through peer authentication. Override it when needed:

```sh
DATABASE_URL=postgresql://user:password@localhost:5432/todoDB npm run dev
```

For a production-style run with offline asset caching:

```sh
npm run build
npm start
```

Then open <http://localhost:3001>.

## Sync confirmation

Successful API responses leave mutations in the local queue until Electric delivers
the acknowledged server version or a newer version of that row. These acknowledged
mutations are not resent, and continue protecting local changes across reloads.

Deletes retain an ID and version as a server-side tombstone (`deleted = true`), with
the label cleared. Tombstones are synced but hidden from the todo list: an absent
row in an older snapshot is not sufficient proof that a delete has arrived. Keep
tombstones so clients that were offline can still confirm their writes. Use the API
for mutations so updates advance the version and deletes produce tombstones.

Schema additions are applied automatically when the API and client start. Restart
the API and reload clients together when updating to this sync protocol.

Run the sync regression checks with `npm test`.

Each client also persists an identity and a monotonically increasing mutation
revision. Requests send `X-Sync-Client` and `X-Mutation-Revision`; retries reuse the
revision, while a new local change gets a newer one. The server locks a record in
`todo_mutation_cursor` and commits the todo change and its receipt together. Older
requests are ignored and duplicate requests replay their saved response, so a
timed-out PUT cannot finish late and overwrite a newer edit from that client.
Keep these records to protect against delayed retries. This does not resolve
conflicting new edits from different clients.

The new request headers are required: restart the API and reload clients together.
Both database initializers migrate existing tables and queued mutations automatically.

## Frontend structure

- `createLocalDB.js` connects each tab to PGliteWorker using the existing `idb://todo` storage.
- `databaseWorker.js` preloads database assets and opens PGlite only when elected leader. It also owns Electric and HTTP uploads.
- `localSchema.js` initializes/migrates the shared database before it becomes available.
- `app.js` initializes the database, connects the UI to the sync service, and starts the app.
- `todoUI.js` handles DOM rendering, user events, and status text.
- `todoSync.js` handles local reads and mutations, the HTTP queue, retries, and Electric subscriptions.
- `snapshotSync.js` reconciles Electric snapshots while protecting unconfirmed local mutations.

The UI calls the sync service's methods and subscribes to `todos` and `status`
notifications. The sync service returns data and never accesses the DOM.

## Multiple tabs

Tabs share one PGlite database, client identity, and mutation queue through
PGliteWorker. Only the elected worker runs Electric and sends mutations. Tabs use
BroadcastChannel to announce committed edits and receive updates to todos and sync
status. Closing the owning tab elects a replacement automatically. Every open
worker preloads the database assets so takeover also works while offline.

The storage name stays `idb://todo`, preserving existing data. When upgrading from
the old implementation, close all old app tabs before opening the updated app:
old tabs do not participate in the worker election.

Run `npx playwright install chromium` once, then `npm run test:browser` to check
shared offline edits, a single Electric owner, offline takeover, reconnecting, and
persistence after reload. The browser test mocks remote servers and uses isolated
browser storage; it does not modify your todos.
