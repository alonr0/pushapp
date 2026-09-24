import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || import.meta.env.NEXT_PUBLIC_SUPABASE_URL
const key =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!url || !key) {
  throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
}

export const supabase = createClient(url, key)
export const db = Object.freeze({ provider: 'supabase' })

let authPromise
export function ensureSignedIn() {
  if (!authPromise) {
    authPromise = (async () => {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      if (!data.session) {
        const result = await supabase.auth.signInAnonymously()
        if (result.error) throw result.error
      }
    })().catch((error) => {
      authPromise = null
      throw error
    })
  }
  return authPromise
}

export async function joinGroup(groupId, displayName) {
  await ensureSignedIn()
  const { error } = await supabase.rpc('join_group', {
    requested_group_id: groupId.trim().toLowerCase(),
    requested_display_name: displayName.trim(),
  })
  if (error) throw error
}

const snake = (key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const camel = (key) => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
function toDatabase(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [snake(key), value]))
}
function fromDatabase(row) {
  return row && Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]))
}

function target(table, id = null, groupId = null) {
  return { table, id, groupId }
}
export function doc(_db, ...parts) {
  if (parts[0] === 'users') return target('users', parts[1])
  if (parts[0] === 'groups' && parts.length === 2) return target('groups', parts[1])
  if (parts[0] === 'groups' && parts[2] === 'dailyLeaderboards') {
    return target('daily_leaderboards', parts[3], parts[1])
  }
  throw new Error(`Unknown Supabase record path: ${parts.join('/')}`)
}
export function collection(_db, ...parts) {
  if (parts[0] === 'users') return target('users')
  if (parts[0] === 'groups' && parts[2] === 'dailyLeaderboards') {
    return target('daily_leaderboards', null, parts[1])
  }
  throw new Error(`Unknown Supabase collection path: ${parts.join('/')}`)
}
export function where(field, operator, value) {
  return { field: snake(field), operator, value }
}
export function query(reference, ...filters) {
  return { ...reference, filters }
}
export function increment(value) {
  return { __increment: Number(value) }
}
export function serverTimestamp() {
  return new Date().toISOString()
}

function applyFilters(builder, filters = []) {
  for (const filter of filters) {
    if (filter.operator === '==') builder = builder.eq(filter.field, filter.value)
    else throw new Error(`Unsupported filter operator: ${filter.operator}`)
  }
  return builder
}
async function select(reference) {
  await ensureSignedIn()
  let builder = supabase.from(reference.table).select('*')
  if (reference.id != null) builder = builder.eq(reference.table === 'daily_leaderboards' ? 'date' : 'id', reference.id)
  if (reference.groupId != null) builder = builder.eq('group_id', reference.groupId)
  builder = applyFilters(builder, reference.filters)
  const { data, error } = await builder
  if (error) throw error
  return (data || []).map(fromDatabase)
}
function makeSnapshot(reference, rows) {
  if (reference.id != null) {
    const row = rows[0] || null
    return { exists: () => Boolean(row), data: () => row || undefined, id: reference.id }
  }
  const docs = rows.map((row) => ({ id: row.id || row.date, data: () => row }))
  return { docs, size: docs.length, empty: docs.length === 0 }
}
export async function getDoc(reference) {
  return makeSnapshot(reference, await select(reference))
}
export async function getDocs(reference) {
  return makeSnapshot(reference, await select(reference))
}
export function onSnapshot(reference, onData, onError = console.error) {
  let stopped = false
  const refresh = () => select(reference).then((rows) => {
    if (!stopped) onData(makeSnapshot(reference, rows))
  }).catch((error) => { if (!stopped) onError(error) })
  void refresh()
  const channel = supabase.channel(`pushapp:${reference.table}:${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: reference.table }, refresh)
    .subscribe((status, error) => {
      if (status === 'SUBSCRIBED') void refresh()
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && error) onError(error)
    })
  return () => {
    stopped = true
    void supabase.removeChannel(channel)
  }
}

function applyPatch(current, patch) {
  const next = { ...current }
  for (const [rawKey, value] of Object.entries(patch)) {
    const bits = rawKey.split('.')
    const key = bits[0]
    if (bits.length > 1) {
      const nested = { ...(next[key] || {}) }
      nested[bits[1]] = value?.__increment ? (Number(nested[bits[1]]) || 0) + value.__increment : value
      next[key] = nested
    } else {
      next[key] = value?.__increment ? (Number(next[key]) || 0) + value.__increment : value
    }
  }
  return next
}
async function write(reference, row, merge = false) {
  await ensureSignedIn()
  const values = { ...row }
  if (reference.id != null && reference.table !== 'daily_leaderboards') values.id = reference.id
  if (reference.groupId != null) values.groupId = reference.groupId
  const dbRow = toDatabase(values)
  let builder = supabase.from(reference.table)
  const { error } = await (merge ? builder.upsert(dbRow) : builder.insert(dbRow))
  if (error) throw error
}
export async function setDoc(reference, data, options = {}) {
  let row = data
  if (options.merge) {
    const current = await getDoc(reference)
    if (current.exists()) row = { ...current.data(), ...data }
  }
  return write(reference, row, true)
}
export async function updateDoc(reference, patch) {
  const existing = await getDoc(reference)
  if (!existing.exists()) throw new Error(`Record not found: ${reference.table}/${reference.id}`)
  const row = applyPatch(existing.data(), patch)
  await ensureSignedIn()
  const values = toDatabase(row)
  delete values.created_at
  let builder = supabase.from(reference.table).update(values)
  if (reference.table === 'daily_leaderboards') {
    builder = builder.eq('group_id', reference.groupId).eq('date', reference.id)
  } else builder = builder.eq('id', reference.id)
  const { error } = await builder
  if (error) throw error
}

export async function runTransaction(_db, callback) {
  const writes = []
  const transaction = {
    get: getDoc,
    update: (reference, patch) => writes.push(() => updateDoc(reference, patch)),
    set: (reference, data) => writes.push(() => setDoc(reference, data, { merge: true })),
  }
  const result = await callback(transaction)
  for (const commit of writes) await commit()
  return result
}
