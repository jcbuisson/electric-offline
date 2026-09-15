import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Real workers and IndexedDB; mock only the remote API/Electric server.
test('tabs share offline edits, elect a successor offline, and resume sync', { timeout: 90_000 }, async () => {
   const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } })
   let browser
   try {
      await server.listen()
      browser = await chromium.launch()
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const remote = new Map()
      let version = 0, offline = false, initialSnapshots = 0, writes = 0
      const waiting = new Set()
      const errors = []
      await context.route('**/api/todos**', async route => {
         if (offline) return route.abort()
         const request = route.request()
         const payload = request.postDataJSON()
         const id = payload?.id ?? new URL(request.url()).pathname.split('/').at(-1)
         const deleted = request.method() === 'DELETE'
         const row = { id, ...payload, deleted, version: String(++version) }
         remote.set(id, row)
         writes++
         await route.fulfill({ status: deleted ? 204 : 200, json: deleted ? undefined : row,
            headers: { 'X-Sync-Version': row.version } })
         for (const wake of waiting) wake()
         waiting.clear()
      })
      await context.route('http://localhost:3200/**', async route => {
         if (offline) return route.abort()
         const url = new URL(route.request().url())
         if (url.searchParams.get('table') !== 'todo') return route.abort()
         const initial = url.searchParams.get('offset') === '-1'
         if (initial) initialSnapshots++
         if (!initial && Number(url.searchParams.get('offset')?.split('_')[0]) >= version) {
            await new Promise(resolve => {
               const timer = setTimeout(() => { waiting.delete(wake); resolve() }, 1000)
               const wake = () => { clearTimeout(timer); resolve() }
               waiting.add(wake)
            })
         }
         if (offline) return route.abort()
         const messages = [...remote.values()].map(row => ({
            key: row.id, value: row, headers: { operation: initial ? 'insert' : 'update', relation: ['public', 'todo'] },
         }))
         messages.push({ headers: { control: 'up-to-date' } })
         await route.fulfill({ json: messages, headers: {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': '*',
            'electric-handle': 'test-shape', 'electric-offset': `${version}_0`,
            'electric-cursor': String(Date.now()),
            'electric-schema': JSON.stringify({ id: { type: 'uuid' }, label: { type: 'text' },
               completed: { type: 'bool' }, deleted: { type: 'bool' }, version: { type: 'int8' } }),
         } })
      })
      const a = await context.newPage()
      const b = await context.newPage()
      for (const page of [a, b]) {
         page.on('pageerror', error => errors.push(error.message))
         page.on('console', message => {
            if (message.type() === 'error' && message.text().includes('Leader changed')) errors.push(message.text())
         })
      }
      await a.goto(origin)
      await a.waitForFunction(() => document.querySelector('#status').textContent === 'Synced')
      await b.goto(origin)
      await b.waitForFunction(() => document.querySelector('#status').textContent === 'Synced')
      assert.equal(initialSnapshots, 1, 'one Electric owner across both tabs')

      offline = true
      await context.setOffline(true)
      await a.locator('#new-todo').fill('Shared offline')
      await b.locator('#new-todo').fill('Other tab')
      await Promise.all([a.locator('#new-todo').press('Enter'), b.locator('#new-todo').press('Enter')])
      await b.getByRole('textbox', { name: 'Edit Shared offline', exact: true }).waitFor()
      await b.getByRole('checkbox', { name: 'Mark Shared offline complete', exact: true }).check()
      await a.waitForFunction(() => document.querySelector('input[aria-label="Mark Shared offline complete"]')?.checked)
      assert.equal(writes, 0)

      const aIsLeader = await a.evaluate(async () => (await import('/createLocalDB.js')).db.isLeader)
      const survivor = aIsLeader ? b : a
      await (aIsLeader ? a : b).close()
      await survivor.waitForFunction(async () => {
         try {
            const { db } = await import('/createLocalDB.js')
            return db.isLeader && (await db.query('SELECT 1')).rows.length === 1
         } catch { return false }
      })
      await survivor.locator('#new-todo').fill('After takeover')
      await survivor.locator('#new-todo').press('Enter')
      await survivor.getByRole('textbox', { name: 'Edit After takeover', exact: true }).waitFor()
      assert.equal(await survivor.locator('.label').count(), 3)

      offline = false
      await context.setOffline(false)
      await survivor.waitForFunction(() => document.querySelector('#status').textContent === 'Synced')
      assert.equal(remote.size, 3)
      assert.equal([...remote.values()].find(row => row.label === 'Shared offline').completed, true)
      assert.equal(writes, 3, 'each offline create uploaded once')
      assert.equal(initialSnapshots, 2, 'successor owns the new Electric stream')
      await survivor.reload()
      await survivor.waitForFunction(() => document.querySelectorAll('.label').length === 3)
      assert.deepEqual(errors, [])
      await context.close()
   } finally {
      await browser?.close()
      await server.close()
   }
})
