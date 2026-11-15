/**
 * Host half of the script library.
 *
 * The panel is a thin view over one directory on disk:
 * - `<store>/registry.json` — every callable entry;
 * - `<store>/.seen.json` — the scan baseline;
 * - `<store>/roots.json` — optional extra scan roots.
 *
 * Three routes:
 * - `registry` lists the entries with what can be checked without running them;
 * - `scan` runs the bundled read-only scanner and returns what is new;
 * - `register` appends chosen entries, then acknowledges the baseline.
 *
 * Nothing machine-specific ships with the package: the store defaults to
 * `~/.dsh/script-library`, adopts an existing `~/.dsh/skills/script-index`
 * when one is present, and every registered workspace joins the scan roots.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'script-library'

/** The Web route registry is the only hard dependency; subprocess is read optionally. */
export const inject = ['webServer']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const SCANNER = join(PACKAGE_ROOT, 'scripts', 'scan.py')
const DEFAULTS = join(PACKAGE_ROOT, 'defaults', 'registry.json')

const SCAN_ROUTE = '/plugin/script-library/scan'
const REGISTER_ROUTE = '/plugin/script-library/register'
const REGISTRY_ROUTE = '/plugin/script-library/registry'

const MAX_BODY_BYTES = 256 * 1024
const SCAN_TIMEOUT_MS = 120 * 1000
const ACK_TIMEOUT_MS = 120 * 1000
const PROBE_TIMEOUT_MS = 20 * 1000

/** Interpreter per script suffix; an empty value means "run the file directly". */
const INTERP = {
  '.py': 'python3',
  '.sh': 'bash',
  '.command': 'bash',
  '.mjs': 'node',
  '.js': 'node',
  '.ts': 'node',
  '.swift': '',
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// ---------------------------------------------------------------- helpers

/** Expand a leading `~` without touching the rest of the path. */
function expandHome(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value === '~') return homedir()
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/** Render an absolute path with the home directory abbreviated. */
function shortHome(absolute) {
  const home = homedir()
  return absolute.startsWith(home + '/') ? '~/' + absolute.slice(home.length + 1) : absolute
}

/** Kebab-case identifier derived from a file name. */
function slug(value) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'script' : cleaned
}

/**
 * Where the registry lives. An explicit `storeDir` wins; otherwise adopt an
 * existing `script-index` skill so this package can take over a running setup.
 */
function storeDir(config) {
  const configured = typeof config?.storeDir === 'string' ? config.storeDir.trim() : ''
  if (configured !== '') return expandHome(configured)

  const adopted = join(homedir(), '.dsh', 'skills', 'script-index')
  if (existsSync(join(adopted, 'registry.json'))) return adopted

  return join(homedir(), '.dsh', 'script-library')
}

/** The script file a registry entry points at, resolved against its cwd. */
function entryScriptPath(entry) {
  const entryLine = typeof entry?.entry === 'string' ? entry.entry.trim() : ''
  if (entryLine === '') return null
  const cwd = expandHome(entry.cwd ?? '~')
  const tokens = entryLine.split(/\s+/)
  for (const token of tokens) {
    if (token.startsWith('-')) continue
    if (token.startsWith('~') || token.startsWith('/') || token.startsWith('./')) {
      const expanded = expandHome(token)
      return expanded.startsWith('/') ? resolve(expanded) : resolve(cwd, expanded)
    }
  }
  for (const token of tokens) {
    if (Object.hasOwn(INTERP, extname(token).toLowerCase())) return resolve(cwd, token)
  }
  return null
}

/** What the panel can see about one registered entry without running it. */
function inspect(entry) {
  const problems = []
  const cwd = expandHome(entry?.cwd ?? '~')
  if (!existsSync(cwd)) problems.push('目录不存在')

  const script = entryScriptPath(entry)
  if (typeof entry?.entry === 'string' && entry.entry !== '' && script !== null && !existsSync(script)) {
    problems.push('入口不存在')
  }

  for (const need of Array.isArray(entry?.needs) ? entry.needs : []) {
    const name = String(need)
    const candidate = name.startsWith('~') ? expandHome(name) : (name.includes('/') ? resolve(cwd, name) : null)
    if (candidate !== null && !existsSync(candidate)) problems.push('缺 ' + name)
  }
  return problems
}

/** Read the registry, seeding a brand-new store from the packaged defaults. */
async function readRegistry(store) {
  const target = join(store, 'registry.json')
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return { version: 1, ...parsed, entries }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    try {
      const seed = JSON.parse(await readFile(DEFAULTS, 'utf8'))
      return { version: 1, updatedAt: null, note: '', ...seed, entries: [] }
    } catch {
      return { version: 1, updatedAt: null, note: '', entries: [] }
    }
  }
}

/** Write the registry through a temporary file so a crash cannot truncate it. */
async function writeRegistry(store, registry) {
  await mkdir(store, { recursive: true })
  const target = join(store, 'registry.json')
  const body = JSON.stringify(
    { ...registry, updatedAt: new Date().toISOString().slice(0, 10) },
    null,
    2,
  ) + '\n'
  const temporary = target + '.tmp'
  await writeFile(temporary, body, 'utf8')
  await rename(temporary, target)
}

/** Run one child process with collected output and a timeout. */
async function runProcess(ctx, { argv, cwd, timeoutMs }) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw Object.assign(new Error('no subprocess service'), { code: 'no-subprocess' })

  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 512 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 5000,
  })

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      handle.terminate()
      reject(Object.assign(new Error('command timed out'), { code: 'timeout' }))
    }, timeoutMs)
    timer.unref?.()
  })

  try {
    const outcome = await Promise.race([handle.done, timeout])
    return {
      exitCode: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  } finally {
    clearTimeout(timer)
  }
}

function tail(text) {
  const value = String(text ?? '').trim()
  return value.length > 400 ? '…' + value.slice(-400) : value
}

/** Run the bundled scanner against one store and parse its JSON report. */
async function runScanner(ctx, store, flag) {
  if (!existsSync(SCANNER)) {
    throw Object.assign(new Error('scanner not found: ' + SCANNER), { code: 'missing-scanner' })
  }
  const result = await runProcess(ctx, {
    argv: ['python3', SCANNER, '--store', store, ...flag],
    cwd: PACKAGE_ROOT,
    timeoutMs: flag.includes('--json') ? SCAN_TIMEOUT_MS : ACK_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    throw Object.assign(
      new Error(tail(result.stderr || result.stdout || 'scanner exited with code ' + result.exitCode)),
      { code: 'scan-failed' },
    )
  }
  return result.stdout
}

/** Absolute paths of every registered workspace, read from the optional Host service. */
function workspacePaths(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return []
  try {
    return registry
      .list()
      .map((workspace) => String(workspace?.path ?? ''))
      .filter((path) => path.startsWith('/'))
  } catch {
    return []
  }
}

/** Absolute roots the scanner already covers, asked from the scanner itself. */
async function configuredRoots(ctx, store) {
  try {
    const result = await runProcess(ctx, {
      argv: ['python3', SCANNER, '--store', store, '--print-roots'],
      cwd: PACKAGE_ROOT,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) return []
    const parsed = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) return []
    return parsed.map((entry) => String(entry?.abs ?? '')).filter((path) => path.startsWith('/'))
  } catch {
    return []
  }
}

/**
 * Registered workspaces that no configured root already covers, so a workspace
 * added in the app later becomes scannable without editing anything.
 */
async function extraRoots(ctx, store) {
  const covered = await configuredRoots(ctx, store)
  return workspacePaths(ctx).filter((path) =>
    existsSync(path) && !covered.some((root) => path === root || path.startsWith(root + '/')))
}

/** Everything the panel needs to describe one candidate row. */
function describe(absolute) {
  const extension = extname(absolute).toLowerCase()
  const file = basename(absolute)
  const interpreter = INTERP[extension] ?? ''
  return {
    path: shortHome(absolute),
    absPath: absolute,
    id: slug(basename(file, extension)),
    title: file,
    kind: 'tool',
    cwd: shortHome(dirname(absolute)),
    entry: interpreter === '' ? file : interpreter + ' ' + file,
    what: '',
    args: '',
  }
}

// ---------------------------------------------------------------- routes

/** Report the scripts written since the last sweep that the registry lacks. */
async function scanOnce(ctx, config) {
  const store = storeDir(config)
  const added = await extraRoots(ctx, store)
  const addArgs = added.flatMap((path) => ['--add-root', path])
  const report = JSON.parse(await runScanner(ctx, store, ['--json', ...addArgs]) || '{}')
  const registry = await readRegistry(store)

  const known = new Set()
  for (const entry of registry.entries) {
    const path = entryScriptPath(entry)
    if (path !== null) known.add(path)
  }

  const candidates = []
  for (const row of Array.isArray(report.rows) ? report.rows : []) {
    const absolute = expandHome(row.path)
    if (absolute === '' || !existsSync(absolute) || known.has(resolve(absolute))) continue
    candidates.push({ ...describe(absolute), root: row.root ?? shortHome(dirname(absolute)) })
  }

  return {
    ok: true,
    store,
    candidates,
    registered: registry.entries.length,
    fresh: Array.isArray(report.rows) ? report.rows.length : 0,
    workspaces: added,
  }
}

/** Append the submitted rows to the registry, then acknowledge the scan baseline. */
async function registerOnce(ctx, config, payload) {
  const store = storeDir(config)
  const registry = await readRegistry(store)

  const usedIds = new Set(registry.entries.map((entry) => String(entry.id)))
  const usedPaths = new Set()
  for (const entry of registry.entries) {
    const path = entryScriptPath(entry)
    if (path !== null) usedPaths.add(path)
  }

  const items = Array.isArray(payload?.items) ? payload.items : []
  if (items.length === 0) return { ok: true, added: [], skipped: [], total: registry.entries.length }
  if (items.length > 50) {
    throw Object.assign(new Error('too many items in one request'), { code: 'too-many-items' })
  }

  const added = []
  const skipped = []
  for (const item of items) {
    const absolute = expandHome(item?.path)
    if (absolute === '' || !existsSync(absolute)) {
      skipped.push({ id: item?.id ?? '', reason: 'missing-file' })
      continue
    }
    const resolved = resolve(absolute)
    if (usedPaths.has(resolved)) {
      skipped.push({ id: item?.id ?? '', reason: 'already-registered' })
      continue
    }

    const what = typeof item?.what === 'string' ? item.what.trim() : ''
    if (what === '') {
      skipped.push({ id: item?.id ?? '', reason: 'empty-what' })
      continue
    }

    const base = slug(typeof item?.id === 'string' && item.id !== '' ? item.id : basename(resolved))
    let id = ID_PATTERN.test(base) ? base : slug(base)
    let counter = 2
    while (usedIds.has(id)) id = base + '-' + counter++

    const entryLine = typeof item?.entry === 'string' && item.entry.trim() !== ''
      ? item.entry.trim()
      : describe(resolved).entry

    registry.entries.push({
      id,
      kind: typeof item?.kind === 'string' && item.kind !== '' ? item.kind : 'tool',
      title: typeof item?.title === 'string' && item.title.trim() !== '' ? item.title.trim() : basename(resolved),
      what,
      tags: Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag)).filter((tag) => tag !== '') : [],
      cwd: typeof item?.cwd === 'string' && item.cwd.trim() !== '' ? item.cwd.trim() : shortHome(dirname(resolved)),
      entry: entryLine,
      args: typeof item?.args === 'string' ? item.args.trim() : '',
      needs: Array.isArray(item?.needs)
        ? item.needs.map((need) => String(need)).filter((need) => need !== '')
        : [],
      note: typeof item?.note === 'string' ? item.note.trim() : '',
    })
    usedIds.add(id)
    usedPaths.add(resolved)
    added.push(id)
  }

  if (added.length > 0) {
    await writeRegistry(store, registry)
    try {
      const extra = await extraRoots(ctx, store)
      await runScanner(ctx, store, ['--ack', ...extra.flatMap((path) => ['--add-root', path])])
    } catch {
      // The entries are already durable; a failed baseline refresh only means
      // these rows may reappear in the next scan.
    }
  }

  return { ok: true, added, skipped, total: registry.entries.length }
}

/** The whole registry, with what the panel can verify about each entry. */
async function registryOnce(config) {
  const store = storeDir(config)
  const registry = await readRegistry(store)
  const entries = registry.entries.map((entry) => ({ ...entry, problems: inspect(entry) }))
  return { ok: true, store, total: entries.length, entries }
}

function sendJson(req, res, status, value) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, max-age=0',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Collect a bounded UTF-8 request body. */
function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflow = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        rejectPromise(Object.assign(new Error('body too large'), { code: 'too-large' }))
        return
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', rejectPromise)
  })
}

/**
 * Mount the routes.
 * @param ctx - Host plugin context carrying the Web route registry.
 * @param config - Optional `storeDir` override for the registry directory.
 */
export function apply(ctx, config = {}) {
  const scanRoute = async (req, res) => {
    try {
      sendJson(req, res, 200, await scanOnce(ctx, config))
    } catch (error) {
      sendJson(req, res, 500, {
        ok: false,
        code: error?.code ?? 'internal',
        message: String(error?.message ?? error),
      })
    }
  }

  const registryRoute = async (req, res) => {
    try {
      sendJson(req, res, 200, await registryOnce(config))
    } catch (error) {
      sendJson(req, res, 500, {
        ok: false,
        code: error?.code ?? 'internal',
        message: String(error?.message ?? error),
      })
    }
  }

  const registerRoute = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { ok: false, code: 'method-not-allowed' })
      return
    }
    try {
      const payload = JSON.parse(await readBody(req))
      sendJson(req, res, 200, await registerOnce(ctx, config, payload))
    } catch (error) {
      sendJson(req, res, 400, {
        ok: false,
        code: error?.code ?? 'bad-request',
        message: String(error?.message ?? error),
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SCAN_ROUTE, handler: scanRoute }), 'script-library: scan route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: REGISTRY_ROUTE, handler: registryRoute }), 'script-library: registry route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: REGISTER_ROUTE, handler: registerRoute }), 'script-library: register route')
}
