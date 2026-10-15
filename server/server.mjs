// The limits-left sync server: each machine posts its own count and readings, and gets every
// machine's back. One JSON file holds them; nothing here reads a conversation.
import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'

const TOKEN = process.env.TOKEN ?? ''
const PORT = Number(process.env.PORT ?? 8080)
const FILE = process.env.DATA_FILE ?? '/data/state.json'
// A machine not heard from in this long is dropped.
const FORGET_MS = 30 * 24 * 60 * 60 * 1000
const MAX_BODY = 1024 * 1024
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/

if (TOKEN.length < 16) {
  console.error('TOKEN must be set, 16 characters at least')
  process.exit(1)
}

const load = async () => {
  try {
    const state = JSON.parse(await readFile(FILE, 'utf8'))

    return typeof state.devices === 'object' && state.devices !== null ? state : { devices: {} }
  } catch {
    return { devices: {} }
  }
}

let state = await load()
// One write at a time, each a whole new file moved into place.
let saving = Promise.resolve()
const save = () => {
  saving = saving.then(async () => {
    await mkdir(dirname(FILE), { recursive: true })
    await writeFile(`${FILE}.tmp`, JSON.stringify(state))
    await rename(`${FILE}.tmp`, FILE)
  })

  return saving
}

const isAuthorized = header => {
  const given = Buffer.from(String(header ?? ''))
  const wanted = Buffer.from(`Bearer ${TOKEN}`)

  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

const answer = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = req =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const isState = body =>
  typeof body === 'object' &&
  body !== null &&
  typeof body.device === 'string' &&
  DEVICE.test(body.device) &&
  typeof body.own === 'number' &&
  Number.isFinite(body.own) &&
  Array.isArray(body.events) &&
  typeof body.windows === 'object' &&
  body.windows !== null

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return answer(res, 200, { ok: true })
  if (req.method !== 'POST' || req.url !== '/v1/sync') return answer(res, 404, { error: 'not found' })
  if (!isAuthorized(req.headers.authorization)) return answer(res, 401, { error: 'unauthorized' })

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return answer(res, 400, { error: 'bad body' })
  }
  if (!isState(body)) return answer(res, 400, { error: 'bad body' })

  const now = Date.now()
  const devices = Object.fromEntries(Object.entries(state.devices).filter(([, device]) => now - device.at < FORGET_MS))
  devices[body.device] = { own: body.own, events: body.events, windows: body.windows, at: now }
  state = { devices }
  await save()

  return answer(res, 200, { devices })
}).listen(PORT, () => console.log(`limits-left sync on :${PORT}`))
