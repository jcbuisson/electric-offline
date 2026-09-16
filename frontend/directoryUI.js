// Plain DOM UI. Drafts live here; persistence, memberships and sync live in directorySync.
export async function createDirectoryUI(service) {
   const root = document.querySelector('#directory')
   root.innerHTML = `
      <header><div><p class="eyebrow">Offline directory</p><h1>People & groups</h1></div>
         <span id="directory-status" class="status">Starting…</span></header>
      <nav class="directory-tabs" aria-label="Directory"><button type="button" data-tab="users">Users</button><button type="button" data-tab="groups">Groups</button></nav>
      <p id="directory-error" role="alert" hidden></p>
      <div id="directory-failures" hidden><p></p><button type="button">Retry failed changes</button></div>
      <div class="directory-layout"><section aria-label="Directory records">
         <div class="directory-tools"><input type="search" aria-label="Search directory" placeholder="Search names or email"><button type="button" id="directory-new">New user</button></div>
         <ul id="directory-list"></ul></section>
         <section id="directory-detail" aria-label="Record editor"></section></div>`
   let tab = 'users', selected = null, dirty = false, saving = false, refreshing = false, refreshAgain = false
   let data = { users: [], groups: [], memberships: [], mutations: [] }
   let baselineGroups = new Set()
   const list = root.querySelector('#directory-list'), detail = root.querySelector('#directory-detail')
   const search = root.querySelector('input[type=search]'), errorBox = root.querySelector('#directory-error')
   const fullname = user => [user.firstname, user.lastname].filter(Boolean).join(' ')
   const table = () => tab === 'users' ? 'app_user' : 'app_group'
   function fail(error) { errorBox.textContent = error.message; errorBox.hidden = false }
   function choose(id) {
      if (saving) return
      if (dirty && !confirm('Discard unsaved changes?')) return
      selected = id; dirty = false; errorBox.hidden = true; renderEditor(); renderList()
   }
   root.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
      if (saving) return
      if (dirty && !confirm('Discard unsaved changes?')) return
      tab = button.dataset.tab; selected = null; dirty = false; search.value = ''; renderList(); renderEditor()
   }))
   root.querySelector('#directory-new').addEventListener('click', () => choose(null))
   search.addEventListener('input', renderList)
   root.querySelector('#directory-failures button').addEventListener('click', () => service.retryFailed().catch(fail))
   function element(tag, text, className) {
      const node = document.createElement(tag)
      if (text !== undefined) node.textContent = text
      if (className) node.className = className
      return node
   }
   function renderList() {
      root.querySelector('#directory-new').textContent = tab === 'users' ? 'New user' : 'New group'
      root.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tab === tab)))
      const records = data[tab].filter(row => Object.values(row).some(value => String(value).toLowerCase().includes(search.value.toLowerCase())))
      list.replaceChildren(...records.map(row => {
         const item = element('li'), name = tab === 'users' ? fullname(row) : row.name
         const select = element('button', name, 'record-select')
         select.type = 'button'; select.setAttribute('aria-label', `Edit ${tab === 'users' ? 'user' : 'group'} ${name}`)
         select.setAttribute('aria-pressed', String(selected === row.id)); select.addEventListener('click', () => choose(row.id))
         const description = element('div'); description.append(select)
         if (tab === 'users') {
            description.append(element('small', row.email))
            const ids = data.memberships.filter(r => r.user_uid === row.id).map(r => r.group_uid)
            description.append(element('small', data.groups.filter(g => ids.includes(g.id)).map(g => g.name).join(', ')))
         } else description.append(element('small', `${data.memberships.filter(r => r.group_uid === row.id).length} members`))
         const mutation = data.mutations.find(m => m.table_name === table() && m.row_id === row.id)
         if (mutation) description.append(element('small', mutation.status === 'failed' ? mutation.failure_reason : 'Pending sync'))
         const remove = element('button', 'Delete', 'record-delete'); remove.type = 'button'
         remove.setAttribute('aria-label', `Delete ${tab === 'users' ? 'user' : 'group'} ${name}`)
         remove.addEventListener('click', async () => {
            if (saving) return
            if (!confirm(`Delete ${name} and its memberships?`)) return
            try {
               await service.remove(table(), row.id)
               if (selected === row.id) { selected = null; dirty = false; renderEditor() }
            } catch (error) { fail(error) }
         })
         item.append(description, remove); return item
      }))
      if (!records.length) list.append(element('li', 'No matching records.', 'directory-empty'))
   }
   function renderEditor() {
      const row = data[tab].find(row => row.id === selected)
      if (selected && !row) { detail.replaceChildren(element('p', 'This record was deleted. Select another record or create a new one.')); return }
      const form = document.createElement('form'); form.className = 'directory-form'
      form.append(element('h2', `${selected ? 'Edit' : 'New'} ${tab === 'users' ? 'user' : 'group'}`))
      const fields = tab === 'users' ? [['firstname','First name'], ['lastname','Last name'], ['email','Email']] : [['name','Group name']]
      for (const [field, caption] of fields) {
         const label = element('label', caption), input = document.createElement('input')
         input.name = field; input.value = row?.[field] ?? ''; input.type = field === 'email' ? 'email' : 'text'
         input.maxLength = 320; input.required = field === 'email' || field === 'name'
         label.append(input); form.append(label)
      }
      if (tab === 'users') {
         baselineGroups = new Set(data.memberships.filter(r => r.user_uid === selected).map(r => r.group_uid))
         const groups = document.createElement('fieldset'); groups.append(element('legend', 'Groups'))
         for (const group of data.groups) {
            const label = element('label', undefined, 'membership-option'), input = document.createElement('input')
            input.type = 'checkbox'; input.name = 'groups'; input.value = group.id; input.checked = baselineGroups.has(group.id)
            label.append(input, document.createTextNode(group.name)); groups.append(label)
         }
         if (!data.groups.length) groups.append(element('p', 'Create a group to assign memberships.'))
         form.append(groups)
      } else if (row) {
         const members = data.memberships.filter(r => r.group_uid === selected).map(r => r.user_uid)
         form.append(element('p', `Members: ${data.users.filter(u => members.includes(u.id)).map(fullname).join(', ') || 'None'}`))
      }
      const submit = element('button', 'Save'); submit.type = 'submit'; form.append(submit)
      form.addEventListener('input', () => { dirty = true })
      form.addEventListener('submit', async event => {
         event.preventDefault()
         if (saving) return
         saving = true; submit.disabled = true; errorBox.hidden = true
         try {
            const values = new FormData(form), selectedGroups = new Set(values.getAll('groups'))
            form.querySelectorAll('input, button').forEach(input => { input.disabled = true })
            selected = await service.save(table(), selected, Object.fromEntries(values))
            if (tab === 'users') {
               for (const id of selectedGroups) if (!baselineGroups.has(id)) await service.setMembership(selected, id, true)
               for (const id of baselineGroups) if (!selectedGroups.has(id)) await service.setMembership(selected, id, false)
            }
            dirty = false
         } catch (error) { fail(error) }
         finally {
            saving = false
            form.querySelectorAll('input, button').forEach(input => { input.disabled = false })
            await refresh()
         }
      })
      detail.replaceChildren(form)
   }
   async function refresh() {
      if (refreshing) { refreshAgain = true; return }
      refreshing = true
      try {
         do {
            refreshAgain = false
            data = await service.read(); renderList()
            const pending = data.mutations.filter(m => m.status === 'pending').length
            const failed = data.mutations.filter(m => m.status === 'failed')
            const status = root.querySelector('#directory-status')
            status.className = `status ${data.online ? 'online' : 'offline'}`
            status.textContent = `${data.online ? 'Online' : 'Offline'}${pending ? ` · ${pending} pending` : ''}${failed.length ? ` · ${failed.length} failed` : ''}`
            const failures = root.querySelector('#directory-failures'); failures.hidden = !failed.length
            failures.querySelector('p').textContent = [...new Set(failed.map(m => m.failure_reason))].join('. ')
            // Preserve unsaved text and checkbox drafts when another tab or Electric
            // updates the lists. An explicit save/cancel controls replacing the editor.
            if (!saving && !dirty && !detail.contains(document.activeElement)) renderEditor()
         } while (refreshAgain)
      } finally { refreshing = false }
   }
   service.subscribe(refresh)
   await refresh()
}
