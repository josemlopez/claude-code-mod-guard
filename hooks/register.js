// mod-guard: a guard for Claude Code mods.
//
// 1. plugin.register: before another user mod loads, read every file in its plugin directory, hash them, and ask a
//    model to review the code. Refuse the mod unless the review says "allow". The verdict is cached by the hash of the
//    whole directory, so an unchanged mod is reviewed once and a changed one is reviewed again.
// 2. process.run / process.spawn: when a reviewed mod starts a program, every file of its own plugin directory named
//    in the command line must still have the hash it had at review time. A script edited after the review is denied.
//
// The guard fails closed: if the review can't run, the mod doesn't load.

const MODEL = 'opus'                 // the reviewer; any alias or model id Claude Code accepts
const MAX_FILES = 200
const MAX_BYTES = 350000             // total source sent to the reviewer
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

const SYSTEM = [
  'You review Claude Code mods for security before they load on a developer machine.',
  'A mod runs inside Claude Code with the user\'s permissions: it can read and write files, start programs,',
  'call the session\'s connectors (email, calendar, drive) and reach the network, without a permission prompt.',
  'Read every file. Look for: reading secrets, credentials or environment variables; sending data anywhere;',
  'starting programs, especially scripts outside the plugin or downloaded at runtime; timers that act in the',
  'background; code that is loaded or fetched later so the reviewed code is not the code that runs;',
  'obfuscation; behaviour that does not match the description.',
  'Answer with JSON only: {"decision":"allow"|"refuse","risk":"low"|"medium"|"high","reasons":["..."]}.',
  'Refuse when the mod does anything a user would not expect from its description, or when you are unsure.',
].join(' ')

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function collect($, dir, rel, out) {
  if (out.length >= MAX_FILES) return
  let entries = []
  try { entries = await $.fs.list(dir) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.isLink) continue
    const path = dir + '/' + e.name
    const name = rel ? rel + '/' + e.name : e.name
    if (e.kind === 'dir') await collect($, path, name, out)
    else if (e.kind === 'file' && out.length < MAX_FILES) {
      let text = ''
      try { text = await $.fs.read(path) } catch { text = '[unreadable]' }
      out.push({ name, path, text, hash: await sha256(text) })
    }
  }
}

function parseVerdict(raw) {
  const text = typeof raw === 'string' ? raw : (raw && (raw.text || '')) || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

async function review($, e) {
  const files = []
  await collect($, e.root, '', files)
  const tree = await sha256(files.map(f => f.name + ':' + f.hash).join('\n'))
  const cached = await $.store.get('verdict:' + e.provenance)
  if (cached && cached.tree === tree) return cached

  let budget = MAX_BYTES
  const body = files.map(f => {
    const t = f.text.length > budget ? f.text.slice(0, Math.max(0, budget)) + '\n[truncated]' : f.text
    budget -= t.length
    return '=== ' + f.name + ' (sha256 ' + f.hash.slice(0, 12) + ')\n' + t
  }).join('\n\n')
  const prompt = 'Mod: ' + e.name + ' (' + e.provenance + ')\n' +
    'Declared by the scanner: hooks ' + JSON.stringify(e.uses.events || []) +
    '; calls ' + JSON.stringify(e.uses.calls || []) + '\n\n' + body

  const raw = await $.model.complete({ model: MODEL, system: SYSTEM, prompt, maxTokens: 1500 })
  const v = parseVerdict(raw) || { decision: 'refuse', risk: 'high', reasons: ['the reviewer gave no readable verdict'] }
  const verdict = {
    tree, decision: v.decision === 'allow' ? 'allow' : 'refuse', risk: v.risk || 'unknown',
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 6) : [], at: new Date(await $.clock.now()).toISOString(),
    root: e.root, files: Object.fromEntries(files.map(f => [f.path, f.hash])),
  }
  await $.store.set('verdict:' + e.provenance, verdict)
  return verdict
}

async function checkMod($, e, next) {
  if (e.tier !== 'user') return next(e)
  const v = await review($, e)
  $.ui.log('mod-guard ' + v.decision + ' ' + e.provenance + ' (' + v.risk + '): ' + v.reasons.join('; '), { to: 'debug' })
  if (v.decision !== 'allow') {
    return { refuse: 'mod-guard: ' + (v.reasons[0] || 'not approved') + ' (risk ' + v.risk + ')' }
  }
  return next(e)
}

async function changedArg($, e, who) {
  if (!who || who === 'mod-guard') return null
  const keys = await $.store.keys()
  for (const k of keys) {
    if (!k.startsWith('verdict:') || k.slice('verdict:'.length).split('@')[0] !== who) continue
    const v = await $.store.get(k)
    if (!v || !v.root || !v.files) continue
    for (const arg of e.argv || []) {
      if (typeof arg !== 'string' || !arg.startsWith(v.root + '/')) continue
      let now = null
      try { now = await sha256(await $.fs.read(arg)) } catch {}
      if (v.files[arg] !== now) {
        $.ui.log('mod-guard denied ' + who + ': ' + arg + ' changed since review', { to: 'debug' })
        return 'mod-guard: ' + arg + ' changed after the review'
      }
    }
  }
  return null
}

async function checkRun($, e, next) {
  const deny = await changedArg($, e, next.origin && next.origin.plugin)
  return deny ? { deny } : next(e)
}

async function* checkSpawn($, e, next) {
  const deny = await changedArg($, e, next.origin && next.origin.plugin)
  if (deny) return { deny }
  return yield* next(e)
}

export function register(on) {
  on('plugin.register', checkMod).catch(async ($, e, next) => {
    if (e.tier !== 'user') return next(e)
    return { refuse: 'mod-guard: the review failed, so this mod was not loaded' }
  })
  // fail closed here too: if the hash check itself breaks, the program does not start
  on('process.run', checkRun).catch(async () => ({ deny: 'mod-guard: the script check failed' }))
  on('process.spawn', checkSpawn).catch(async function* () { return { deny: 'mod-guard: the script check failed' } })
}
