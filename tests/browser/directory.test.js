import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { prepareDirectoryServer } from '../../backend/directorySchema.js'
import { applyDirectoryMutation } from '../../backend/directoryMutations.js'
import { directoryValues } from '../../shared/directoryModels.js'

test('users, groups and memberships work offline across tabs and reconnect', { timeout: 90_000 }, async () => {
   const remote = new PGlite()
   const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } })
   let browser, context
   try {
      await prepareDirectoryServer({ query: sql => remote.exec(sql) })
      await server.listen(); browser = await chromium.launch()
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`
      context = await browser.newContext({ serviceWorkers: 'block' })
      const pages = [await context.newPage(), await context.newPage()]
      const errors = [], uploads = []
      for (const page of pages) {
         page.on('pageerror', error => { console.log('Browser error:', error.stack); errors.push(error.message) })
         page.on('console', message => { if (message.text().includes('Directory')) console.log(message.text()) })
      }
      let offline = false
      await context.route('**/api/directory/**', async route => {
         if (offline) return route.abort()
         const request = route.request(), parts = new URL(request.url()).pathname.split('/')
         const table = parts[3], id = parts[4]
         const action = request.method() === 'POST' ? 'create' : request.method() === 'PUT' ? 'update' : 'delete'
         const row = await remote.transaction(tx => applyDirectoryMutation(tx, {
            table, id, action, values: action === 'delete' ? undefined : directoryValues(table, request.postDataJSON()),
            clientId: request.headers()['x-sync-client'], revision: request.headers()['x-mutation-revision'],
         }))
         uploads.push(table)
         await route.fulfill({ json: row, headers: { 'X-Sync-Version': String(row.version) } })
      })
      await context.route('http://localhost:3200/**', async route => {
         const url = new URL(route.request().url()), table = url.searchParams.get('table')
         if (offline || table === 'todo') return route.abort()
         if (url.searchParams.get('offset') !== '-1') await new Promise(resolve => setTimeout(resolve, 1500))
         if (offline) return route.abort()
         const rows = (await remote.query(`SELECT * FROM ${table}`)).rows
         const version = Math.max(0, ...rows.map(row => Number(row.version)))
         const fields = table === 'app_user' ? ['firstname','lastname','email'] : table === 'app_group' ? ['name'] : ['user_uid','group_uid']
         const schema = Object.fromEntries(fields.map(field => [field, { type: 'text' }]))
         Object.assign(schema, { id: { type: 'uuid' }, deleted: { type: 'bool' }, version: { type: 'int8' } })
         await route.fulfill({ json: [
            ...rows.map(row => ({ key: row.id, value: row, headers: { operation: 'insert', relation: ['public',table] } })),
            { headers: { control: 'up-to-date' } },
         ], headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*',
            'electric-handle': table, 'electric-offset': `${version}_0`, 'electric-cursor': String(Date.now()),
            'electric-schema': JSON.stringify(schema) } }).catch(error => {
            // Electric can cancel a long poll during reconnect/reload. Playwright
            // may already have handled that route when its delayed mock replies.
            if (!error.message.includes('Route is already handled')) throw error
         })
      })
      const [a, b] = pages
      for (const page of pages) {
         await page.goto(origin)
         await page.waitForFunction(() => document.querySelector('#directory-status')?.textContent === 'Online')
      }
      offline = true; await context.setOffline(true)
      await a.getByRole('button', { name: 'Groups', exact: true }).click()
      await a.getByLabel('Group name', { exact: true }).fill('Editors')
      await a.locator('#directory-detail').getByRole('button', { name: 'Save', exact: true }).click()
      await a.getByRole('button', { name: 'Edit group Editors', exact: true }).waitFor()
      await b.getByRole('button', { name: 'Groups', exact: true }).click()
      await b.getByRole('button', { name: 'Edit group Editors', exact: true }).waitFor()
      await a.getByRole('button', { name: 'Users', exact: true }).click()
      await a.getByLabel('First name', { exact: true }).fill('Alice')
      await a.getByLabel('Last name', { exact: true }).fill('Example')
      await a.getByLabel('Email', { exact: true }).fill('alice@example.com')
      await a.getByRole('checkbox', { name: 'Editors', exact: true }).check()
      await a.locator('#directory-detail').getByRole('button', { name: 'Save', exact: true }).click()
      await b.getByRole('button', { name: 'Users', exact: true }).click()
      await b.getByRole('button', { name: 'Edit user Alice Example', exact: true }).click()
      await b.waitForFunction(() => document.querySelector('#directory-detail input[name=groups]')?.checked)
      // An incoming edit in another tab must not discard this unsaved draft.
      await b.getByLabel('First name', { exact: true }).fill('Alicia')
      await a.getByRole('button', { name: 'Groups', exact: true }).click()
      await a.getByLabel('Group name', { exact: true }).fill('Reviewers')
      await a.locator('#directory-detail').getByRole('button', { name: 'Save', exact: true }).click()
      await b.waitForFunction(() => document.querySelector('#directory-status')?.textContent.includes('4 pending'))
      assert.equal(await b.getByLabel('First name', { exact: true }).inputValue(), 'Alicia')
      await b.locator('#directory-detail').getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal(uploads.length, 0)
      console.log('Directory browser: drafts preserved; reconnecting')
      offline = false; await context.setOffline(false)
      await b.waitForFunction(() => document.querySelector('#directory-status')?.textContent === 'Online').catch(async error => {
         console.log('uploads', uploads, 'status', await b.locator('#directory-status').textContent(), 'queue', await b.evaluate(async () => (await (await import('/createLocalDB.js')).db.query('SELECT * FROM mutation_queue')).rows))
         throw error
      })
      assert.equal((await remote.query('SELECT firstname FROM app_user WHERE NOT deleted')).rows[0].firstname, 'Alicia')
      assert.equal((await remote.query('SELECT * FROM user_group_relation WHERE NOT deleted')).rows.length, 1)
      assert.ok(uploads.indexOf('user_group_relation') > uploads.indexOf('app_user'))
      assert.ok(uploads.indexOf('user_group_relation') > uploads.indexOf('app_group'))

      console.log('Directory browser: uploaded and acknowledged')
      // Deleting a group removes its memberships in the UI and on the server.
      await a.getByRole('button', { name: 'Groups', exact: true }).click()
      a.once('dialog', dialog => dialog.accept())
      await a.getByRole('button', { name: 'Delete group Editors', exact: true }).click()
      await a.getByRole('button', { name: 'Delete group Editors', exact: true }).waitFor({ state: 'detached' })
      await a.waitForFunction(() => document.querySelector('#directory-status')?.textContent === 'Online')
      assert.equal((await remote.query('SELECT * FROM user_group_relation WHERE NOT deleted')).rows.length, 0)
      console.log('Directory browser: cascade confirmed; reloading')
      await b.reload()
      await b.getByRole('button', { name: 'Edit user Alicia Example', exact: true }).waitFor()
      assert.deepEqual(errors, [])
      console.log('Directory browser: workflow complete')
   } finally { await context?.unrouteAll({ behavior: 'ignoreErrors' }); await browser?.close(); await server.close(); await remote.close() }
})
