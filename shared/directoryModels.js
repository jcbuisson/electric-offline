// SQL identifiers come only from this fixed registry, never from request input.
export const directoryModels = {
   app_user: { label: 'User', fields: ['firstname', 'lastname', 'email'] },
   app_group: { label: 'Group', fields: ['name'] },
   user_group_relation: { label: 'Membership', fields: ['user_uid', 'group_uid'] },
}

export function directoryModel(table) {
   const model = Object.hasOwn(directoryModels, table) && directoryModels[table]
   if (!model) throw Object.assign(new Error('Unknown directory model'), { status: 400 })
   return model
}

export function requireUUID(value) {
   if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw Object.assign(new Error('Invalid ID'), { status: 400 })
   }
   return value
}

export function directoryValues(table, input) {
   const { fields } = directoryModel(table)
   const values = Object.fromEntries(fields.map(field => [field, String(input?.[field] ?? '').trim()]))
   const invalid = message => { throw Object.assign(new Error(message), { status: 400 }) }
   if (Object.values(values).some(value => value.length > 320)) invalid('Field is too long')
   if (table === 'app_user') {
      if (!values.firstname && !values.lastname) invalid('A first or last name is required')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) invalid('A valid email is required')
      values.email = values.email.toLowerCase()
   }
   if (table === 'app_group' && !values.name) invalid('Group name is required')
   if (table === 'user_group_relation') {
      requireUUID(values.user_uid)
      requireUUID(values.group_uid)
   }
   return values
}

// One stable UUID per pair: two offline clients adding the same membership agree
// on its identity. Removing and re-adding it updates that same relationship.
export async function membershipId(userId, groupId) {
   const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(`membership:${userId.toLowerCase()}:${groupId.toLowerCase()}`)))
   bytes[6] = (bytes[6] & 15) | 80
   bytes[8] = (bytes[8] & 63) | 128
   const hex = Array.from(bytes.slice(0, 16), n => n.toString(16).padStart(2, '0')).join('')
   return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
