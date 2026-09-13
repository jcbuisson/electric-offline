// Renders todos and handles user interaction. Persistence and sync live in todoSync.js.

export async function createTodoUI(todos) {
   const list = document.querySelector('#todo-list')
   const empty = document.querySelector('#empty')
   const form = document.querySelector('#new-todo-form')
   const input = document.querySelector('#new-todo')
   const status = document.querySelector('#status')

   todos.subscribe((change) => change === 'todos' ? render() : updateStatus())
   form.addEventListener('submit', createTodo)
   await render()

   async function createTodo(event) {
      event.preventDefault()
      const label = input.value.trim()
      if (!label) return
      await todos.createTodo(label)
      input.value = ''
   }

   async function render() {
      const rows = await todos.getTodos()
      list.replaceChildren(...rows.map(todoElement))
      empty.hidden = rows.length > 0
      await updateStatus()
   }

   function todoElement(todo) {
      const item = document.createElement('li')
      item.className = `${todo.completed ? 'completed ' : ''}${todo.pending ? 'pending' : ''}`.trim()

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = todo.completed
      checkbox.setAttribute('aria-label', `Mark ${todo.label} complete`)
      checkbox.addEventListener('change', () => todos.editTodo(todo.id, todo.label, checkbox.checked))

      const label = document.createElement('span')
      label.className = 'label'
      label.contentEditable = 'plaintext-only'
      label.textContent = todo.label
      label.setAttribute('role', 'textbox')
      label.setAttribute('aria-label', `Edit ${todo.label}`)
      label.addEventListener('keydown', (event) => {
         if (event.key === 'Enter') {
            event.preventDefault()
            label.blur()
         }
         if (event.key === 'Escape') {
            label.textContent = todo.label
            label.blur()
         }
      })
      label.addEventListener('blur', () => {
         if (label.textContent !== todo.label) todos.editTodo(todo.id, label.textContent, todo.completed)
      })

      const localId = document.createElement('span')
      localId.className = 'local-id'
      localId.textContent = `#${todo.id}`
      localId.title = 'Local database ID'

      const description = document.createElement('div')
      description.className = 'todo-description'
      description.append(label, localId)

      const remove = document.createElement('button')
      remove.className = 'delete'
      remove.type = 'button'
      remove.textContent = '×'
      remove.setAttribute('aria-label', `Delete ${todo.label}`)
      remove.addEventListener('click', () => todos.deleteTodo(todo.id))

      item.append(checkbox, description, remove)
      return item
   }

   async function updateStatus() {
      const { online, pending, failed } = await todos.getStatus()
      status.className = `status ${online ? 'online' : 'offline'}`
      if (failed) {
         status.textContent = `${online ? 'Online' : 'Offline'} · ${failed} failed${pending ? ` · ${pending} pending` : ''}`
      } else {
         status.textContent = online ? (pending ? `Online · ${pending} pending` : 'Synced') : (pending ? `Offline · ${pending} pending` : 'Offline')
      }
   }
}
