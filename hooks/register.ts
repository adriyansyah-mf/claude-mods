import type { EngineInterface, Register } from 'claude-code'

// ============================================================================
// Model router — pilih model + effort per tugas, compact otomatis, pangkas output besar.
// ============================================================================

// Tingkat kesulitan -> alias model. Ubah di sini kalau mau mapping lain.
const TIERS = {
  ringan: 'haiku', // pertanyaan singkat, penjelasan, edit kecil, rename, format
  sedang: 'sonnet', // coding biasa: fitur kecil-menengah, bug jelas, tes, refactor lokal
  berat: 'opus', // arsitektur, debugging sulit, refactor besar, desain sistem, riset multi-langkah
} as const

type Tier = keyof typeof TIERS
const LABELS = Object.keys(TIERS) as Tier[]
const RANK: Record<Tier, number> = { ringan: 0, sedang: 1, berat: 2 }
const BY_RANK: Tier[] = ['ringan', 'sedang', 'berat']

function isTier(x: string | undefined): x is Tier {
  return x !== undefined && (LABELS as string[]).includes(x)
}
function maxTier(a: Tier, b: Tier): Tier {
  return RANK[a] >= RANK[b] ? a : b
}
function bump(t: Tier): Tier {
  return BY_RANK[Math.min(RANK[t] + 1, 2)] ?? 'berat'
}

// Effort per tingkat. Token thinking ditagih sebagai output (mahal). undefined = effort sesi.
const EFFORT: Record<Tier, 'low' | 'medium' | undefined> = { ringan: 'low', sedang: 'medium', berat: undefined }

// Turun tingkat baru setelah sekian prompt lebih rendah berturut-turut.
const DOWNGRADE_AFTER = 2
// Router sadar cache: di atas ukuran konteks ini router tidak turun tingkat, karena menulis
// ulang konteks sebesar itu ke cache model lain lebih mahal dari hemat model yang lebih murah.
const CACHE_HOLD_TOKENS = 100_000

// Naik tingkat otomatis kalau model sebelumnya gagal.
const COMPLAINT = /\b(salah|keliru|ga ?bener|gak ?bener|nggak ?bener|tidak benar|belum bener|masih (error|salah|gagal|belum)|tidak berhasil|ga ?jalan|gak ?jalan|wrong|still (broken|failing|wrong)|doesn'?t work|not working)\b/i
const ESCALATE_TOOL_ERRORS = 3

// Klasifikasi cepat tanpa memanggil model untuk kasus yang jelas.
const HEAVY = /\b(arsitektur|architecture|desain sistem|system design|refactor (seluruh|semua|besar|total)|migrasi|migration|security audit|audit keamanan|threat model|race condition|memory leak|deadlock|root cause)\b/i
const SHORT_LIGHT_MAX = 25

// Prompt pendek "ok/lanjut/ya" tidak diklasifikasi ulang.
const FOLLOW_UP = /^(ok(e|ay)?|ya|yes|lanjut(kan)?|terus|go|continue|next|sip|mantap|gas)[.!\s]*$/i

const RUBRIC = `Nilai tingkat kesulitan permintaan untuk asisten coding ini.
ringan = pertanyaan singkat, penjelasan konsep, edit/rename/format kecil, perintah shell sederhana.
sedang = tugas coding biasa: fitur kecil-menengah, bug yang jelas, menulis tes, refactor satu file.
berat = arsitektur, debugging sulit/tidak jelas, refactor banyak file, desain sistem, keamanan, riset panjang.
Kalau ragu antara dua tingkat, pilih yang lebih tinggi.

Permintaan:
`
const MAX_CHARS = 4000

const COMPACT_INSTRUCTIONS =
  'Pertahankan: tujuan tugas yang sedang dikerjakan, keputusan penting dan alasannya, ' +
  'file yang dibuat/diubah beserta path-nya, error yang belum selesai, dan langkah berikutnya. ' +
  'Buang: output tool yang panjang, isi file yang sudah tidak relevan, percobaan yang gagal.'
const COMPACT_RETRY_MS = 5000
const COMPACT_MAX_TRIES = 12

// Pengaturan yang bisa diubah lewat /router dan disimpan antar sesi ($.store).
type Settings = {
  routeMain: boolean
  routeAgents: boolean
  agentsMax: Tier // batas atas model subagent
  useEffort: boolean
  compactEvery: number // 0 = mati
  compactMinTokens: number
  trimChars: number // 0 = mati; output Bash di atas ini dipangkas
  showCost: boolean
}
const DEFAULTS: Settings = {
  routeMain: true,
  routeAgents: true,
  agentsMax: 'sedang',
  useEffort: true,
  compactEvery: 5,
  compactMinTokens: 50_000,
  trimChars: 12_000,
  showCost: true,
}
const STORE_KEY = 'settings'

function readSettings(raw: unknown): Settings {
  const s = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return s
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = r[k]
    if (k === 'agentsMax') {
      if (typeof v === 'string' && isTier(v)) s.agentsMax = v
    } else if (typeof v === typeof DEFAULTS[k]) {
      ;(s as Record<string, unknown>)[k] = v
    }
  }
  return s
}

async function loadSettings($: EngineInterface): Promise<Settings> {
  try {
    return readSettings(await $.store.get(STORE_KEY))
  } catch {
    return { ...DEFAULTS }
  }
}

async function saveSettings($: EngineInterface, s: Settings): Promise<void> {
  try {
    await $.store.set(STORE_KEY, s)
  } catch {
    // tetap jalan dengan pengaturan di memori
  }
}

function trimText(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.65)
  const tail = max - head
  const cut = text.length - head - tail
  return (
    text.slice(0, head) +
    `\n\n[... model-router: ${cut} karakter di tengah dipangkas untuk menghemat konteks. ` +
    `Jalankan ulang dengan grep/head/tail yang lebih spesifik, atau tambahkan "# notrim" di perintah ...]\n\n` +
    text.slice(text.length - tail)
  )
}

function compactSoon($: EngineInterface, tries: number, done: (note: string) => void): void {
  $.clock.after(tries === 0 ? 1500 : COMPACT_RETRY_MS, () => {
    $.session
      .compact({ instructions: COMPACT_INSTRUCTIONS })
      .then(r => done(r.skip !== undefined ? `compact dilewati: ${r.skip}` : 'compact selesai'))
      .catch((err: unknown) => {
        $.ui.log(`model-router: compact try ${tries + 1} rejected: ${String(err)}`, { to: 'debug' })
        if (String(err).includes('headless')) {
          // -p / SDK: $.session.compact belum didukung; jalankan /compact.
          $.command
            .run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
            .then(() => done('compact selesai lewat /compact (mode headless)'))
            .catch((e2: unknown) => done(`compact gagal: ${String(e2).slice(0, 100)}`))
        } else if (tries + 1 < COMPACT_MAX_TRIES) compactSoon($, tries + 1, done)
        else done(`compact gagal: ${String(err).slice(0, 100)}`)
      })
  })
}

async function classify($: EngineInterface, text: string): Promise<Tier | undefined> {
  const label = await $.model.classify(RUBRIC + text.slice(0, MAX_CHARS), LABELS, { model: 'haiku' })
  return isTier(label) ? label : undefined
}

// Tingkat cepat tanpa model; undefined = perlu classify.
function heuristic(text: string): Tier | undefined {
  if (HEAVY.test(text)) return 'berat'
  if (text.length <= SHORT_LIGHT_MAX && !text.includes('\n')) return 'ringan'
  return undefined
}

async function contextTokens($: EngineInterface): Promise<number> {
  try {
    return (await $.session.usage()).context.tokens ?? 0
  } catch {
    return 0
  }
}

async function sessionCost($: EngineInterface): Promise<number | undefined> {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

function shortModel(id: string): string {
  const m = id.match(/(haiku|sonnet|opus|fable)/i)
  return m?.[1]?.toLowerCase() ?? id
}

const USAGE =
  'Pakai: /router [status] | on | off | main on|off | agents on|off | agents-max ringan|sedang|berat | ' +
  'pin ringan|sedang|berat | unpin | effort on|off | compact <n>|on|off | compact-min <token> | ' +
  'trim <karakter>|off | cost on|off | reset | log'

export const register: Register = on => {
  let cfg: Settings = { ...DEFAULTS }
  let mainTier: Tier | undefined
  let pinned: Tier | undefined
  let lowerStreak = 0
  let lowerMax: Tier | undefined
  let toolErrors = 0 // error tool di loop utama selama giliran terakhir
  let escalateNext = false // giliran terakhir gagal: naikkan prompt berikutnya
  let lastEffort: string | undefined
  let lastCost: number | undefined
  let promptsSinceCompact = 0
  let compactPending = false
  const log: string[] = []

  const remember = (line: string) => {
    log.push(line)
    if (log.length > 30) log.shift()
  }

  on('session.start', async ($, e, next) => {
    cfg = await loadSettings($)
    await $.command.register({ name: 'router', description: 'Model router: status dan pengaturan (ketik /router help)' })
    return next(e)
  })

  // ---------------------------------------------------------------- /router
  on('command.run', { command: 'router' }, async ($, e) => {
    const [a = 'status', b] = e.args.trim().split(/\s+/).filter(Boolean)
    let changed = true
    if (a === 'on' || a === 'off') {
      cfg.routeMain = cfg.routeAgents = a === 'on'
      if (a === 'off') mainTier = undefined
    } else if ((a === 'main' || a === 'agents') && (b === 'on' || b === 'off')) {
      if (a === 'main') {
        cfg.routeMain = b === 'on'
        if (!cfg.routeMain) mainTier = undefined
      } else cfg.routeAgents = b === 'on'
    } else if (a === 'agents-max' && isTier(b)) {
      cfg.agentsMax = b
    } else if (a === 'effort' && (b === 'on' || b === 'off')) {
      cfg.useEffort = b === 'on'
    } else if (a === 'compact') {
      if (b === 'off') cfg.compactEvery = 0
      else if (b === 'on') cfg.compactEvery = cfg.compactEvery || DEFAULTS.compactEvery
      else if (b !== undefined && /^\d+$/.test(b) && Number(b) >= 1) cfg.compactEvery = Number(b)
      else return { text: USAGE }
    } else if (a === 'compact-min' || a === 'trim') {
      const m = b?.toLowerCase().match(/^(\d+)(k?)$/)
      const n = b === 'off' ? 0 : m ? Number(m[1]) * (m[2] ? 1000 : 1) : undefined
      if (n === undefined) return { text: USAGE }
      if (a === 'trim') cfg.trimChars = n === 0 ? 0 : Math.max(n, 2000)
      else cfg.compactMinTokens = n
    } else if (a === 'cost' && (b === 'on' || b === 'off')) {
      cfg.showCost = b === 'on'
    } else if (a === 'reset') {
      cfg = { ...DEFAULTS }
    } else {
      changed = false
      if (a === 'pin' && isTier(b)) {
        pinned = b
        mainTier = b
        lowerStreak = 0
        lowerMax = undefined
      } else if (a === 'unpin') {
        pinned = undefined
      } else if (a === 'log') {
        return { text: log.length ? log.join('\n') : 'Belum ada keputusan routing.' }
      } else if (a !== 'status') {
        return { text: USAGE }
      }
    }
    if (changed) await saveSettings($, cfg)
    const tier = mainTier ? `${mainTier} (${TIERS[mainTier]})` : 'belum ada'
    const cost = await sessionCost($)
    return {
      text:
        `Router — prompt utama: ${cfg.routeMain ? 'ON' : 'OFF'}, subagent: ${cfg.routeAgents ? `ON (maks ${cfg.agentsMax})` : 'OFF'}, ` +
        `pin: ${pinned ?? '-'}, tingkat sekarang: ${tier}, model default sesi: ${await $.session.model()}, ` +
        `effort: ${cfg.useEffort ? 'ON' : 'OFF'}, ` +
        `auto compact: ${cfg.compactEvery ? `tiap ${cfg.compactEvery} prompt (${promptsSinceCompact}/${cfg.compactEvery}), min ${Math.round(cfg.compactMinTokens / 1000)}k token` : 'OFF'}, ` +
        `trim Bash: ${cfg.trimChars ? `${Math.round(cfg.trimChars / 1000)}k karakter` : 'OFF'}, ` +
        `biaya sesi: ${cost === undefined ? '-' : `~$${cost.toFixed(3)} (perkiraan)`}` +
        (changed ? ' — disimpan untuk sesi berikutnya.' : ''),
    }
  })

  // ---------------------------------------------------------------- compact
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.skip === undefined && e.trigger !== 'precompute') promptsSinceCompact = 0
    return r
  }).catch(($, e, next) => next(e))

  // --------------------------------------------- akhir giliran: biaya, eskalasi, compact
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r

    // Eskalasi: giliran berakhir error atau banyak error tool -> prompt berikutnya naik satu tingkat.
    if (e.reason === 'error' || toolErrors >= ESCALATE_TOOL_ERRORS) {
      escalateNext = true
      remember(`giliran gagal (${e.reason === 'error' ? 'error API' : `${toolErrors} error tool`}): prompt berikutnya dinaikkan`)
    }
    toolErrors = 0

    // Biaya per giliran (perkiraan dari selisih biaya sesi).
    if (cfg.showCost) {
      const total = await sessionCost($)
      if (total !== undefined) {
        const delta = lastCost === undefined ? total : total - lastCost
        lastCost = total
        const model = e.usage ? shortModel(e.usage.model) : mainTier ? TIERS[mainTier] : '?'
        $.ui.status(`router: ${model}${lastEffort ? `·${lastEffort}` : ''} · giliran ~$${delta.toFixed(4)} · sesi ~$${total.toFixed(3)}`)
      }
    }

    // Auto compact tiap N prompt, kalau konteks sudah cukup besar.
    if (cfg.compactEvery > 0 && !compactPending && promptsSinceCompact >= cfg.compactEvery) {
      const tokens = await contextTokens($)
      if (tokens < cfg.compactMinTokens) {
        remember(`autocompact dilewati: konteks ${Math.round(tokens / 1000)}k < ${Math.round(cfg.compactMinTokens / 1000)}k token`)
        promptsSinceCompact = 0
        return r
      }
      compactPending = true
      $.ui.status(`auto compact setelah ${promptsSinceCompact} prompt…`)
      compactSoon($, 0, note => {
        compactPending = false
        promptsSinceCompact = 0 // juga saat gagal, supaya tidak mencoba ulang di setiap prompt
        remember(`autocompact: ${note}`)
        $.ui.toast(`model-router: ${note}`)
        $.ui.log(`model-router: autocompact: ${note}`, { to: 'debug' })
      })
    }
    return r
  })

  // ---------------------------------------------------------------- prompt utama
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    const isUserPrompt = e.command === undefined && e.isMeta !== true && text.length > 0
    if (isUserPrompt) promptsSinceCompact += 1
    if (!isUserPrompt || !cfg.routeMain || pinned !== undefined) return next(e)

    const complained = COMPLAINT.test(text)
    const escalate = escalateNext || complained
    escalateNext = false
    if (mainTier !== undefined && FOLLOW_UP.test(text) && !escalate) return next(e)

    try {
      const quick = heuristic(text)
      let tier = quick ?? (await classify($, text))
      if (tier === undefined) return next(e)
      const via = quick ? 'heuristik' : 'haiku'

      // Eskalasi: minimal satu tingkat di atas tingkat sekarang.
      if (escalate && mainTier !== undefined) {
        const up = bump(mainTier)
        if (RANK[up] > RANK[tier]) {
          remember(`eskalasi (${complained ? 'keluhan' : 'giliran gagal'}): ${tier} -> ${up}`)
          tier = up
        }
      }

      const prev = mainTier
      if (prev === undefined || RANK[tier] >= RANK[prev]) {
        mainTier = tier
        lowerStreak = 0
        lowerMax = undefined
      } else {
        lowerStreak += 1
        lowerMax = lowerMax === undefined ? tier : maxTier(lowerMax, tier)
        const tokens = await contextTokens($)
        if (tokens > CACHE_HOLD_TOKENS) {
          remember(`dinilai ${tier}, tetap ${prev}: konteks ${Math.round(tokens / 1000)}k token (ganti model = tulis ulang cache)`)
        } else if (lowerStreak >= DOWNGRADE_AFTER) {
          mainTier = lowerMax
          lowerStreak = 0
          lowerMax = undefined
        } else {
          remember(`dinilai ${tier}, tetap ${prev} (${lowerStreak}/${DOWNGRADE_AFTER} untuk turun)`)
        }
      }
      const now: Tier = mainTier ?? tier
      if (now !== prev) remember(`prompt: ${prev ?? '-'} -> ${now} (${TIERS[now]}) via ${via}: "${text.slice(0, 60)}"`)
      $.ui.status(`router: ${now} → ${TIERS[now]}${now !== tier ? ` (dinilai ${tier})` : ''}`)
    } catch (err) {
      remember(`prompt: gagal klasifikasi (${String(err).slice(0, 80)}), model sebelumnya dipakai`)
      $.ui.log(`model-router: classify failed: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ------------------------------------------- tiap request di loop utama: model + effort
  on('turn.step', async function* ($, e, next) {
    if (!cfg.routeMain || mainTier === undefined || e.agentId !== undefined) {
      if (e.agentId === undefined) lastEffort = typeof e.effort === 'string' ? e.effort : undefined
      return yield* next(e)
    }
    const model = TIERS[mainTier]
    const effort = cfg.useEffort && e.effort !== undefined ? EFFORT[mainTier] : undefined
    lastEffort = effort ?? (typeof e.effort === 'string' ? e.effort : undefined)
    if (e.index === 0) {
      $.ui.log(`model-router: main step -> ${model}, effort ${lastEffort ?? '-'} (was ${e.model})`, { to: 'debug' })
    }
    return yield* next(effort === undefined ? { ...e, model } : { ...e, model, effort })
  })

  // ------------------------------------------- tool: hitung error, pangkas output Bash besar
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.isError === true) toolErrors += 1
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (cfg.trimChars <= 0 || r.deny !== undefined || r.isError === true || e.command.includes('# notrim')) return r
    const out = r.result
    if (out.isImage === true || (out.stdout.length <= cfg.trimChars && out.stderr.length <= cfg.trimChars)) return r
    const before = out.stdout.length + out.stderr.length
    const trimmed = { ...out, stdout: trimText(out.stdout, cfg.trimChars), stderr: trimText(out.stderr, cfg.trimChars) }
    remember(`trim Bash: ${before} -> ${trimmed.stdout.length + trimmed.stderr.length} karakter (${e.command.slice(0, 40)})`)
    return { result: trimmed }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- subagent
  on('agent.spawn', async ($, e, next) => {
    let model = e.model
    if (cfg.routeAgents && model === undefined && !e.fork) {
      try {
        const brief = `${e.description}\n\n${e.prompt}`
        let tier = heuristic(e.description) ?? (await classify($, brief))
        if (tier !== undefined) {
          if (RANK[tier] > RANK[cfg.agentsMax]) tier = cfg.agentsMax
          model = TIERS[tier]
          remember(`agent "${e.description}": ${tier} -> ${model}`)
        }
      } catch (err) {
        remember(`agent: gagal klasifikasi (${String(err).slice(0, 80)})`)
      }
    }
    return next(model === e.model ? e : { ...e, model })
  }).catch(($, e, next) => next(e))
}
