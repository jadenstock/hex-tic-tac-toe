import type { BotSearchSession } from './search.ts'
import {
  chooseBotTurn as chooseBotTurnJs,
  chooseBotTurnDetailedAsyncWithSession as chooseBotTurnDetailedAsyncWithSessionJs,
  chooseBotTurnDetailedWithSession as chooseBotTurnDetailedWithSessionJs,
  createBotSearchSession,
  chooseGreedyTurn as chooseGreedyTurnJs,
} from './search.ts'
import {
  DEFAULT_BOT_SEARCH_OPTIONS,
  DEFAULT_BOT_TUNING,
  type Axial,
  type BotSearchOptions,
  type BotSearchStats,
  type BotTurnDecision,
  type BotTuning,
  type LiveLikeState,
  type MoveRecord,
  type Player,
} from './types.ts'

export type BotBackend = 'js' | 'wasm'
export type WasmBotRuntimeStatus = 'idle' | 'loading' | 'ready' | 'failed'

const BOT_BACKEND_STORAGE_KEY = 'hex-ttt.bot.backend'
const WASM_MODULE_URL = '/wasm-bot/hex_ttt_wasm.js'
const WASM_BINARY_URL = '/wasm-bot/hex_ttt_wasm_bg.wasm'

type ProgressOptions = {
  onProgress?: (progress: {
    elapsedMs: number
    nodesExpanded: number
    playouts: number
    boardEvaluations: number
    maxDepthTurns: number
  }) => void
  yieldEveryMs?: number
}

type WasmGlueModule = {
  default?: (input?: string | URL | Request | Response | BufferSource | WebAssembly.Module) => Promise<unknown>
  choose_turn_json?: (inputJson: string) => string
}

type WasmTurnRequest = {
  turn: Player
  placements_left: number
  max_time_ms: number
  max_nodes: number
  tuning: {
    threat_weights: number[]
    defense_weight: number
    tempo_discount_per_stone: number
    threat_severity_scale: number
    candidate_radius: number
    top_k_first_moves: number
  }
  search_options: {
    exploration_c: number
    turn_candidate_count: number
    child_turn_candidate_count: number
    max_simulation_turns: number
    simulation_turn_candidate_count: number
    simulation_radius: number
    simulation_top_k_first_moves: number
  }
  moves: Array<{
    q: number
    r: number
    mark: Player
  }>
}

type WasmTurnResponse = {
  moves?: Array<{ q?: number; r?: number }>
  mode?: string
  stop_reason?: string
  nodes_expanded?: number
  playouts?: number
  board_evaluations?: number
  root_candidates?: number
  max_depth_turns?: number
  error?: string
}

const STOP_REASONS: ReadonlySet<BotSearchStats['stopReason']> = new Set([
  'budget_zero',
  'time',
  'nodes',
  'terminal',
  'no_candidates',
  'fallback',
  'early_win',
  'single_candidate',
  'deterministic',
])

let preferredBotBackend: BotBackend = resolveInitialPreferredBackend()
let wasmRuntimeStatus: WasmBotRuntimeStatus = 'idle'
let wasmRuntimeMessage: string | null = null
let wasmModuleRef: WasmGlueModule | null = null
let wasmLoadPromise: Promise<WasmGlueModule | null> | null = null

function canUseBrowserWasm(): boolean {
  return typeof window !== 'undefined' && typeof WebAssembly !== 'undefined'
}

function resolvePublicAssetUrl(path: string): string {
  if (typeof window === 'undefined') return path

  const base = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.BASE_URL ?? '/'
  const baseUrl = new URL(base, window.location.href)
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path
  return new URL(normalizedPath, baseUrl).toString()
}

function readBackendFromEnv(): string {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  const fromVite = meta.env?.VITE_BOT_BACKEND
  if (typeof fromVite === 'string') return fromVite

  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VITE_BOT_BACKEND
  if (typeof fromProcess === 'string') return fromProcess

  return ''
}

function resolveInitialPreferredBackend(): BotBackend {
  const envValue = readBackendFromEnv().trim().toLowerCase()
  let backend: BotBackend = envValue === 'wasm' ? 'wasm' : 'js'

  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(BOT_BACKEND_STORAGE_KEY)
      if (stored === 'wasm' || stored === 'js') {
        backend = stored
      }
    } catch {
      // Ignore storage access errors and keep env/default value.
    }
  }

  return backend
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function normalizeSearchOptions(partialOptions: Partial<BotSearchOptions>): BotSearchOptions {
  return {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    ...partialOptions,
    budget: {
      ...DEFAULT_BOT_SEARCH_OPTIONS.budget,
      ...(partialOptions.budget ?? {}),
    },
  }
}

function normalizeStopReason(raw: unknown): BotSearchStats['stopReason'] {
  if (typeof raw === 'string' && STOP_REASONS.has(raw as BotSearchStats['stopReason'])) {
    return raw as BotSearchStats['stopReason']
  }
  return 'deterministic'
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function parseBoardKey(key: string): Axial | null {
  const [qRaw, rRaw] = key.split(',')
  const q = Number(qRaw)
  const r = Number(rRaw)
  if (!Number.isInteger(q) || !Number.isInteger(r)) return null
  return { q, r }
}

function toOrderedMoveArray(state: LiveLikeState): MoveRecord[] {
  if (state.moveHistory.length > 0) {
    return state.moveHistory.map((move) => ({ q: move.q, r: move.r, mark: move.mark }))
  }

  const fallback: MoveRecord[] = []
  for (const [key, mark] of state.moves.entries()) {
    const parsed = parseBoardKey(key)
    if (!parsed) continue
    fallback.push({ q: parsed.q, r: parsed.r, mark })
  }
  fallback.sort((a, b) => (a.q !== b.q ? a.q - b.q : a.r - b.r))
  return fallback
}

function toWasmTurnRequest(state: LiveLikeState, options: BotSearchOptions, tuning: BotTuning): WasmTurnRequest {
  return {
    turn: state.turn,
    placements_left: Math.max(1, Math.min(2, Math.floor(state.placementsLeft))),
    max_time_ms: Math.max(0, Math.floor(options.budget.maxTimeMs)),
    max_nodes: Math.max(0, Math.floor(options.budget.maxNodes)),
    tuning: {
      threat_weights: [...tuning.threatWeights],
      defense_weight: tuning.defenseWeight,
      tempo_discount_per_stone: tuning.tempoDiscountPerStone,
      threat_severity_scale: tuning.threatSeverityScale,
      candidate_radius: Math.max(1, Math.floor(tuning.candidateRadius)),
      top_k_first_moves: Math.max(1, Math.floor(tuning.topKFirstMoves)),
    },
    search_options: {
      exploration_c: options.explorationC,
      turn_candidate_count: Math.max(1, Math.floor(options.turnCandidateCount)),
      child_turn_candidate_count: Math.max(1, Math.floor(options.childTurnCandidateCount)),
      max_simulation_turns: Math.max(1, Math.floor(options.maxSimulationTurns)),
      simulation_turn_candidate_count: Math.max(1, Math.floor(options.simulationTurnCandidateCount)),
      simulation_radius: Math.max(1, Math.floor(options.simulationRadius)),
      simulation_top_k_first_moves: Math.max(1, Math.floor(options.simulationTopKFirstMoves)),
    },
    moves: toOrderedMoveArray(state),
  }
}

function normalizeWasmMoves(rawMoves: unknown, state: LiveLikeState): Axial[] {
  if (!Array.isArray(rawMoves)) return []

  const occupied = new Set<string>()
  for (const key of state.moves.keys()) occupied.add(key)

  const deduped = new Set<string>()
  const normalized: Axial[] = []

  for (const entry of rawMoves) {
    if (!entry || typeof entry !== 'object') continue
    const cell = entry as { q?: unknown; r?: unknown }
    const q = Number(cell.q)
    const r = Number(cell.r)
    if (!Number.isInteger(q) || !Number.isInteger(r)) continue
    const key = toKey(q, r)
    if (occupied.has(key) || deduped.has(key)) continue
    deduped.add(key)
    normalized.push({ q, r })
  }

  return normalized.slice(0, Math.max(1, Math.min(2, Math.floor(state.placementsLeft))))
}

function buildWasmDecision(
  state: LiveLikeState,
  response: WasmTurnResponse,
  elapsedMs: number,
): BotTurnDecision | null {
  const moves = normalizeWasmMoves(response.moves, state)

  const nodesExpandedRaw = Number(response.nodes_expanded)
  const playoutsRaw = Number(response.playouts)
  const boardEvaluationsRaw = Number(response.board_evaluations)
  const rootCandidatesRaw = Number(response.root_candidates)
  const maxDepthTurnsRaw = Number(response.max_depth_turns)

  const nodesExpanded = Number.isFinite(nodesExpandedRaw) ? Math.max(0, Math.floor(nodesExpandedRaw)) : moves.length
  const boardEvaluations = Number.isFinite(boardEvaluationsRaw)
    ? Math.max(0, Math.floor(boardEvaluationsRaw))
    : nodesExpanded
  const playouts = Number.isFinite(playoutsRaw) ? Math.max(0, Math.floor(playoutsRaw)) : nodesExpanded
  const rootCandidates = Number.isFinite(rootCandidatesRaw)
    ? Math.max(1, Math.floor(rootCandidatesRaw))
    : moves.length
  const maxDepthTurns = Number.isFinite(maxDepthTurnsRaw)
    ? Math.max(0, Math.floor(maxDepthTurnsRaw))
    : 0

  const modeRaw = response.mode
  const mode: BotSearchStats['mode'] = modeRaw === 'mcts' || modeRaw === 'greedy' || modeRaw === 'beam' ? modeRaw : 'beam'

  return {
    moves,
    stats: {
      mode,
      elapsedMs,
      nodesExpanded,
      playouts,
      boardEvaluations,
      maxDepthTurns,
      rootCandidates,
      stopReason: normalizeStopReason(response.stop_reason),
    },
  }
}

function shouldUseStrictWasmPath(): boolean {
  return preferredBotBackend === 'wasm'
}

function createWasmUnavailableError(): Error {
  const runtimeMessage = wasmRuntimeMessage?.trim()
  if (runtimeMessage) return new Error(`WASM backend unavailable: ${runtimeMessage}`)
  return new Error('WASM backend unavailable.')
}

async function loadWasmModule(): Promise<WasmGlueModule | null> {
  if (!canUseBrowserWasm()) {
    wasmRuntimeStatus = 'failed'
    wasmRuntimeMessage = 'Browser WebAssembly runtime is unavailable in this environment.'
    return null
  }

  if (wasmModuleRef?.choose_turn_json) {
    wasmRuntimeStatus = 'ready'
    return wasmModuleRef
  }

  if (wasmLoadPromise) {
    return wasmLoadPromise
  }

  wasmRuntimeStatus = 'loading'
  wasmRuntimeMessage = null

  wasmLoadPromise = (async () => {
    try {
      const moduleUrl = resolvePublicAssetUrl(WASM_MODULE_URL)
      const wasmBinaryUrl = resolvePublicAssetUrl(WASM_BINARY_URL)
      const glue = (await import(/* @vite-ignore */ moduleUrl)) as WasmGlueModule
      if (typeof glue.default === 'function') {
        await glue.default(wasmBinaryUrl)
      }
      if (typeof glue.choose_turn_json !== 'function') {
        throw new Error('WASM module did not expose choose_turn_json.')
      }
      wasmModuleRef = glue
      wasmRuntimeStatus = 'ready'
      wasmRuntimeMessage = null
      return glue
    } catch (error) {
      wasmRuntimeStatus = 'failed'
      wasmRuntimeMessage = error instanceof Error ? error.message : 'Failed to load Rust/WASM bot runtime.'
      wasmModuleRef = null
      return null
    } finally {
      wasmLoadPromise = null
    }
  })()

  return wasmLoadPromise
}

function shouldAttemptWasmBackend(): boolean {
  return preferredBotBackend === 'wasm' && canUseBrowserWasm()
}

function tryChooseTurnFromLoadedWasm(
  state: LiveLikeState,
  tuning: BotTuning,
  partialOptions: Partial<BotSearchOptions>,
): BotTurnDecision | null {
  if (!shouldAttemptWasmBackend()) return null
  if (!wasmModuleRef?.choose_turn_json) return null

  const options = normalizeSearchOptions(partialOptions)
  const request = toWasmTurnRequest(state, options, tuning)
  const startMs = nowMs()

  try {
    const raw = wasmModuleRef.choose_turn_json(JSON.stringify(request))
    const parsed = JSON.parse(raw) as WasmTurnResponse
    if (parsed.error) {
      wasmRuntimeStatus = 'failed'
      wasmRuntimeMessage = parsed.error
      return null
    }
    return buildWasmDecision(state, parsed, Math.max(0, nowMs() - startMs))
  } catch (error) {
    wasmRuntimeStatus = 'failed'
    if (error instanceof Error) {
      wasmRuntimeMessage = `WASM bot execution failed: ${error.message}`
    } else {
      wasmRuntimeMessage = `WASM bot execution failed: ${String(error)}`
    }
    console.error('[WASM bot] sync execution error', error)
    return null
  }
}

async function tryChooseTurnFromWasm(
  state: LiveLikeState,
  tuning: BotTuning,
  partialOptions: Partial<BotSearchOptions>,
): Promise<BotTurnDecision | null> {
  if (!shouldAttemptWasmBackend()) return null

  const module = await loadWasmModule()
  if (!module?.choose_turn_json) return null

  const options = normalizeSearchOptions(partialOptions)
  const request = toWasmTurnRequest(state, options, tuning)
  const startMs = nowMs()

  try {
    const raw = module.choose_turn_json(JSON.stringify(request))
    const parsed = JSON.parse(raw) as WasmTurnResponse
    if (parsed.error) {
      wasmRuntimeStatus = 'failed'
      wasmRuntimeMessage = parsed.error
      return null
    }
    return buildWasmDecision(state, parsed, Math.max(0, nowMs() - startMs))
  } catch (error) {
    wasmRuntimeStatus = 'failed'
    if (error instanceof Error) {
      wasmRuntimeMessage = `WASM bot execution failed: ${error.message}`
    } else {
      wasmRuntimeMessage = `WASM bot execution failed: ${String(error)}`
    }
    console.error('[WASM bot] execution error', error)
    return null
  }
}

export function getPreferredBotBackend(): BotBackend {
  return preferredBotBackend
}

export function setPreferredBotBackend(backend: BotBackend): void {
  preferredBotBackend = backend

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(BOT_BACKEND_STORAGE_KEY, backend)
    } catch {
      // Ignore storage errors.
    }
  }
}

export function getEffectiveBotBackend(): BotBackend {
  return preferredBotBackend
}

export function getWasmBotRuntimeStatus(): WasmBotRuntimeStatus {
  return wasmRuntimeStatus
}

export function getWasmBotRuntimeMessage(): string | null {
  return wasmRuntimeMessage
}

export async function warmupWasmBot(): Promise<boolean> {
  if (!shouldAttemptWasmBackend()) {
    return false
  }
  const module = await loadWasmModule()
  return Boolean(module?.choose_turn_json)
}

export function chooseBotTurnDetailedWithSession(
  state: LiveLikeState,
  session: BotSearchSession,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotTurnDecision {
  const wasmDecision = tryChooseTurnFromLoadedWasm(state, tuning, partialOptions)
  if (wasmDecision) return wasmDecision

  if (shouldUseStrictWasmPath()) {
    throw createWasmUnavailableError()
  }

  return chooseBotTurnDetailedWithSessionJs(state, session, tuning, partialOptions)
}

export function chooseBotTurnDetailed(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotTurnDecision {
  return chooseBotTurnDetailedWithSession(state, createBotSearchSession(), tuning, partialOptions)
}

export async function chooseBotTurnDetailedAsyncWithSession(
  state: LiveLikeState,
  session: BotSearchSession,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
  progressOptions: ProgressOptions = {},
): Promise<BotTurnDecision> {
  const wasmDecision = await tryChooseTurnFromWasm(state, tuning, partialOptions)
  if (wasmDecision) {
    progressOptions.onProgress?.({
      elapsedMs: wasmDecision.stats.elapsedMs,
      nodesExpanded: wasmDecision.stats.nodesExpanded,
      playouts: wasmDecision.stats.playouts,
      boardEvaluations: wasmDecision.stats.boardEvaluations,
      maxDepthTurns: wasmDecision.stats.maxDepthTurns,
    })
    return wasmDecision
  }

  if (shouldUseStrictWasmPath()) {
    throw createWasmUnavailableError()
  }

  return chooseBotTurnDetailedAsyncWithSessionJs(state, session, tuning, partialOptions, progressOptions)
}

export async function chooseBotTurnDetailedAsync(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
  progressOptions: ProgressOptions = {},
): Promise<BotTurnDecision> {
  return chooseBotTurnDetailedAsyncWithSession(state, createBotSearchSession(), tuning, partialOptions, progressOptions)
}

export function chooseBotTurn(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): Axial[] {
  return chooseBotTurnDetailed(state, tuning, partialOptions).moves
}

export function chooseBotTurnWithSession(
  state: LiveLikeState,
  session: BotSearchSession,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): Axial[] {
  return chooseBotTurnDetailedWithSession(state, session, tuning, partialOptions).moves
}

export function chooseGreedyTurn(state: LiveLikeState, tuning: BotTuning = DEFAULT_BOT_TUNING): Axial[] {
  if (preferredBotBackend === 'wasm') {
    const decision = chooseBotTurnDetailed(state, tuning, {
      budget: {
        maxTimeMs: 0,
        maxNodes: 0,
      },
    })
    return decision.moves
  }

  return chooseGreedyTurnJs(state, tuning)
}

export function chooseBotTurnWithJsFallback(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): Axial[] {
  return chooseBotTurnJs(state, tuning, partialOptions)
}
