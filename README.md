# Offline todos

A minimal vanilla-JavaScript todo app. The UI reads and writes PGlite in IndexedDB immediately, queues mutations while offline, sends them to a small Postgres API when connected, and receives Postgres changes through Electric.

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
