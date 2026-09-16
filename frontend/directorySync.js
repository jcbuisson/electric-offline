import { Shape, ShapeStream } from '@electric-sql/client'
import { LeaderChangedError } from '@electric-sql/pglite/worker'
import { directoryModels, directoryModel, directoryValues, membershipId } from '../shared/directoryModels.js'

const tables = Object.keys(directoryModels)

export function createDirectorySync(db, {
   ownsSync = true, channel, network = globalThis.navigator, events = globalThis,
   fetchRequest = (...args) => fetch(...args), shapeUrl = 'http://localhost:3200/v1/shape',
} = {}) {
   const listeners = new Set(), snapshots = new Map(), connected = new Set()
   let started = false, flushing = false, timer, controller, online = false
   let previousSnapshot = Promise.resolve()
   const ordered = operation => {
      const result = previousSnapshot.then(operation)
      previousSnapshot = result.catch(() => {})
      return result
   }
   function notify(broadcast = true) {
      if (broadcast) channel?.postMessage({ online: ownsSync ? online : undefined })
      for (const listener of listeners) Promise.resolve().then(listener).catch(console.error)
   }
   function shared({ data }) {
      if (!ownsSync && data.online !== undefined) online = data.online
      notify(false)
      if (ownsSync) void flushQueue()
   }
   function connectivity() { notify(); if (ownsSync) void flushQueue() }
   function start() {
      if (started) return
      started = true
      channel?.addEventListener('message', shared)
      events.addEventListener('online', connectivity)
      events.addEventListener('offline', connectivity)
      if (!ownsSync) { channel?.postMessage({}); return }
      controller = new AbortController()
      for (const table of tables) {
         const stream = new ShapeStream({ url: shapeUrl, signal: controller.signal, params: { table, where: 'true' } })
         stream.subscribe(messages => {
            if (messages.some(message => message.headers.control === 'must-refetch')) {
               void ordered(() => snapshots.delete(table))
               connected.delete(table)
            }
         }, () => { connected.delete(table); online = false; notify() })
         new Shape(stream).subscribe(({ rows }) => {
            void applySnapshot(table, rows).then(() => {
               connected.add(table); online = connected.size === tables.length; notify()
            }).catch(error => { online = false; notify(); console.error('Directory snapshot:', error) })
         })
      }
      void flushQueue()
      // Reconcile cached snapshots as well as retry HTTP: a temporary local write
      // failure must not strand an acknowledged mutation if Electric stays quiet.
      timer = setInterval(() => { void flushQueue(); void reconcile().catch(console.error) }, 5000)
   }
   function stop() {
      started = false; clearInterval(timer); controller?.abort()
      channel?.removeEventListener('message', shared)
      events.removeEventListener('online', connectivity); events.removeEventListener('offline', connectivity)
      online = false; connected.clear(); void ordered(() => snapshots.clear())
   }

   async function upsert(tx, table, id, values) {
      const { fields } = directoryModel(table)
      await tx.query(`INSERT INTO ${table} (id, ${fields.join(',')})
         VALUES (${[id, ...fields].map((_, i) => `$${i+1}`).join(',')})
         ON CONFLICT (id) DO UPDATE SET ${fields.map(field => `${field}=excluded.${field}`).join(',')}`,
      [id, ...fields.map(field => values[field])])
   }
   async function enqueue(tx, table, id, action, values = null) {
      await tx.query(`INSERT INTO mutation_queue (table_name, row_id, action, payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (table_name, row_id) DO UPDATE SET
            action=CASE WHEN excluded.action='update' AND mutation_queue.action='create'
               AND mutation_queue.acknowledged_version IS NULL THEN 'create' ELSE excluded.action END,
            payload=excluded.payload, revision=nextval('mutation_revision_seq'),
            acknowledged_version=NULL, status='pending', failure_reason=NULL`, [table, id, action, JSON.stringify(values)])
   }
   async function save(table, id, input) {
      const values = directoryValues(table, input)
      const creating = !id
      id ||= crypto.randomUUID()
      await db.transaction(async tx => {
         if (table === 'user_group_relation') {
            for (const [parent, field] of [['app_user','user_uid'],['app_group','group_uid']]) {
               if (!(await tx.query(`SELECT id FROM ${parent} WHERE id=$1`, [values[field]])).rows.length) {
                  throw new Error('Select an existing user and group')
               }
            }
         } else if (!creating && !(await tx.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rows.length) {
            throw new Error('This record was deleted. Create a new record instead.')
         }
         await upsert(tx, table, id, values)
         await enqueue(tx, table, id, creating ? 'create' : 'update', values)
      })
      notify(); if (started && ownsSync) void flushQueue()
      return id
   }
   async function remove(table, id) {
      directoryModel(table)
      await db.transaction(async tx => {
         if (table !== 'user_group_relation') {
            const field = table === 'app_user' ? 'user_uid' : 'group_uid'
            const { rows } = await tx.query(`DELETE FROM user_group_relation WHERE ${field}=$1 RETURNING id`, [id])
            for (const row of rows) await enqueue(tx, 'user_group_relation', row.id, 'delete')
         }
         await tx.query(`DELETE FROM ${table} WHERE id=$1`, [id])
         await enqueue(tx, table, id, 'delete')
      })
      notify(); if (started && ownsSync) void flushQueue()
   }
   async function setMembership(userId, groupId, selected) {
      const id = await membershipId(userId, groupId)
      if (selected) return save('user_group_relation', id, { user_uid: userId, group_uid: groupId })
      return remove('user_group_relation', id)
   }
   async function read() {
      while (true) {
         try {
            await db.waitReady
            // One SELECT gives the UI a consistent view without holding a
            // transaction open across several worker round trips.
            const { rows: [state] } = await db.query(`SELECT
               COALESCE((SELECT jsonb_agg(u ORDER BY lastname, firstname) FROM app_user u), '[]') AS users,
               COALESCE((SELECT jsonb_agg(g ORDER BY name) FROM app_group g), '[]') AS groups,
               COALESCE((SELECT jsonb_agg(r) FROM user_group_relation r
                  JOIN app_user u ON u.id=r.user_uid JOIN app_group g ON g.id=r.group_uid), '[]') AS memberships,
               COALESCE((SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object('revision', m.revision::text,
                  'acknowledged_version', m.acknowledged_version::text) ORDER BY seq)
                  FROM mutation_queue m WHERE table_name=ANY($1::text[])), '[]') AS mutations`, [tables])
            return { ...state, online: network.onLine && online }
         } catch (error) { if (!(error instanceof LeaderChangedError)) throw error }
      }
   }
   async function retryFailed() {
      await db.query(`UPDATE mutation_queue SET status='pending', failure_reason=NULL
         WHERE table_name=ANY($1::text[]) AND status='failed'`, [tables])
      notify(); if (ownsSync) await flushQueue()
   }

   // Each shape has its own full snapshot. Never let one table's snapshot erase
   // another table or its queue entries. API versions guard optimistic edits.
   function applySnapshot(table, rows) {
      directoryModel(table)
      return ordered(async () => { snapshots.set(table, rows); await copySnapshot(table, rows) })
   }
   function reconcile() {
      return ordered(async () => {
         for (const [table, rows] of snapshots) await copySnapshot(table, rows)
         notify()
      })
   }
   async function copySnapshot(table, rows) {
      await db.transaction(async tx => {
         for (const row of rows) {
            if (row.version !== undefined) await tx.query(`DELETE FROM mutation_queue
               WHERE table_name=$1 AND row_id=$2 AND acknowledged_version <= $3::numeric`, [table, row.id, String(row.version)])
            const { rows: queued } = await tx.query('SELECT seq FROM mutation_queue WHERE table_name=$1 AND row_id=$2', [table, row.id])
            if (!row.deleted && !queued.length) await upsert(tx, table, row.id, row)
         }
         await tx.query(`DELETE FROM ${table} WHERE NOT (id=ANY($1::uuid[])) AND NOT EXISTS
            (SELECT 1 FROM mutation_queue WHERE table_name=$2 AND row_id=${table}.id::text)`,
         [rows.filter(row => !row.deleted).map(row => row.id), table])
      })
   }

   async function flushQueue() {
      if (!ownsSync || flushing || !network.onLine) return
      flushing = true
      try {
         const { rows: [client] } = await db.query('SELECT id FROM sync_client WHERE singleton')
         let progress = true
         while (progress) {
            progress = false
            const { rows } = await db.query(`SELECT * FROM mutation_queue WHERE table_name=ANY($1::text[])
               AND status='pending' AND acknowledged_version IS NULL ORDER BY seq`, [tables])
            for (const mutation of rows) {
               if (mutation.table_name === 'user_group_relation' && mutation.action !== 'delete') {
                  const parents = [mutation.payload.user_uid, mutation.payload.group_uid]
                  const { rows: blocked } = await db.query(`SELECT seq FROM mutation_queue
                     WHERE table_name IN ('app_user','app_group') AND row_id=ANY($1::text[])
                     AND acknowledged_version IS NULL`, [parents])
                  if (blocked.length) continue
               }
               try {
                  await send(mutation, client.id)
               } catch (error) {
                  if (!error.status || error.status >= 500 || [408,425,429].includes(error.status)) throw error
                  await db.query(`UPDATE mutation_queue SET status='failed', failure_reason=$1
                     WHERE seq=$2 AND revision=$3`, [error.message, mutation.seq, mutation.revision])
               }
               progress = true; notify()
            }
         }
      } catch (error) {
         console.info('Directory queue will retry:', error.message)
      } finally { flushing = false; notify() }
   }
   async function send(mutation, clientId) {
      const { table_name: table, row_id: id, action, payload } = mutation
      const response = await fetchRequest(`/api/directory/${table}/${id}`, {
         method: action === 'delete' ? 'DELETE' : action === 'create' ? 'POST' : 'PUT',
         headers: { 'content-type': 'application/json', 'X-Sync-Client': clientId, 'X-Mutation-Revision': String(mutation.revision) },
         body: action === 'delete' ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
         const body = await response.json().catch(() => ({}))
         throw Object.assign(new Error(body.error || `API returned ${response.status}`), { status: response.status })
      }
      const version = response.headers.get('X-Sync-Version')
      if (!version || !/^\d+$/.test(version)) throw new Error('Missing sync version')
      const row = await response.json()
      await db.transaction(async tx => {
         const { rows: [current] } = await tx.query('SELECT * FROM mutation_queue WHERE seq=$1', [mutation.seq])
         if (!current) return
         // A create may finish after the user edited its values. Follow it with
         // a new PUT; a response must never acknowledge a newer pending change.
         const same = String(current.revision) === String(mutation.revision)
         if (action === 'create' && current.action === 'create' && !row.deleted &&
            directoryModel(table).fields.some(field => row[field] !== current.payload[field])) {
            await tx.query(`UPDATE mutation_queue SET action='update', revision=nextval('mutation_revision_seq') WHERE seq=$1`, [mutation.seq])
         } else if (same) {
            await tx.query('UPDATE mutation_queue SET acknowledged_version=$1 WHERE seq=$2', [version, mutation.seq])
         }
      })
      await reconcile()
   }
   return { start, stop, save, remove, setMembership, read, retryFailed, flushQueue, applySnapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } }
}
