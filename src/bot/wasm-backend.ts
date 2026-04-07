import {
  type BotPositionEvaluation,
  DEFAULT_BOT_SEARCH_OPTIONS,
  DEFAULT_BOT_TUNING,
  type Axial,
  type BotSearchOptions,
  type BotSearchStats,
  type BotSearchTelemetry,
  type BotTurnDecision,
  type BotTuning,
  type LiveLikeState,
  type MoveRecord,
  type Player,
} from './types.ts'

export type BotBackend = 'wasm'
export type WasmBotRuntimeStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type BotSearchSession = {
  runs: number
}

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
  evaluate_position_json?: (inputJson: string) => string
}

type WasmTurnRequest = {
  turn: Player
  placements_left: number
  max_time_ms: number
  max_nodes: number
  tuning: {
    threat_weights: number[]
    threat_breadth_weights: number[]
    defense_weight: number
    tempo_discount_per_stone: number
    threat_severity_scale: number
    one_turn_win_bonus: number
    one_turn_fork_bonus: number
    threat3_cluster_bonus: number
    threat4_fork_bonus: number
    threat5_fork_bonus: number
    threat3_blocker_bonus: number
    active_build_multiplier_one: number
    active_build_multiplier_two: number
    candidate_radius: number
    top_k_first_moves: number
  }
  search_options: {
    exploration_c: number
    turn_candidate_count: number
    child_turn_candidate_count: number
    root_widening_base: number
    root_widening_alpha: number
    root_widening_multiplier: number
    child_widening_base: number
    child_widening_alpha: number
    child_widening_multiplier: number
    mu_fpu_enabled: boolean
    quiescence_enabled: boolean
    quiescence_max_extra_turns: number
    use_static_leaf_eval: boolean
    transpositions_enabled: boolean
    forcing_solver_enabled: boolean
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

type WasmEvaluatePositionRequest = {
  tuning: {
    threat_weights: number[]
    threat_breadth_weights: number[]
    defense_weight: number
    tempo_discount_per_stone: number
    threat_severity_scale: number
    one_turn_win_bonus: number
    one_turn_fork_bonus: number
    threat3_cluster_bonus: number
    threat4_fork_bonus: number
    threat5_fork_bonus: number
    threat3_blocker_bonus: number
    active_build_multiplier_one: number
    active_build_multiplier_two: number
    candidate_radius: number
    top_k_first_moves: number
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
  telemetry?: {
    root_prior_top_share?: number
    root_best_visit_share?: number
    widening_unlock_count?: number
    mu_fpu_selection_count?: number
    quiescence_call_count?: number
    quiescence_extension_count?: number
    transposition_hits?: number
    transposition_misses?: number
    transposition_stores?: number
    transposition_reuses?: number
    transposition_table_size?: number
  }
  error?: string
}

type WasmEvaluatePositionResponse = {
  x_score?: number
  o_score?: number
  x_next_turn_finish_groups?: number
  o_next_turn_finish_groups?: number
  x_next_turn_blockers_required?: number
  o_next_turn_blockers_required?: number
  x_forced_next_turn?: boolean
  o_forced_next_turn?: boolean
  objective_for_x?: number
  objective_for_o?: number
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

const WASM_MODULE_URL = '/wasm-bot/hex_ttt_wasm.js'
const WASM_BINARY_URL = '/wasm-bot/hex_ttt_wasm_bg.wasm'

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
      threat_breadth_weights: [...tuning.threatBreadthWeights],
      defense_weight: tuning.defenseWeight,
      tempo_discount_per_stone: tuning.tempoDiscountPerStone,
      threat_severity_scale: tuning.threatSeverityScale,
      one_turn_win_bonus: tuning.oneTurnWinBonus,
      one_turn_fork_bonus: tuning.oneTurnForkBonus,
      threat3_cluster_bonus: tuning.threat3ClusterBonus,
      threat4_fork_bonus: tuning.threat4ForkBonus,
      threat5_fork_bonus: tuning.threat5ForkBonus,
      threat3_blocker_bonus: tuning.threat3BlockerBonus,
      active_build_multiplier_one: tuning.activeBuildMultiplierOne,
      active_build_multiplier_two: tuning.activeBuildMultiplierTwo,
      candidate_radius: Math.max(1, Math.floor(tuning.candidateRadius)),
      top_k_first_moves: Math.max(1, Math.floor(tuning.topKFirstMoves)),
    },
    search_options: {
      exploration_c: options.explorationC,
      turn_candidate_count: Math.max(1, Math.floor(options.turnCandidateCount)),
      child_turn_candidate_count: Math.max(1, Math.floor(options.childTurnCandidateCount)),
      root_widening_base: Math.max(1, Math.floor(options.rootWideningBase)),
      root_widening_alpha: Math.max(0, options.rootWideningAlpha),
      root_widening_multiplier: Math.max(0, options.rootWideningMultiplier),
      child_widening_base: Math.max(1, Math.floor(options.childWideningBase)),
      child_widening_alpha: Math.max(0, options.childWideningAlpha),
      child_widening_multiplier: Math.max(0, options.childWideningMultiplier),
      mu_fpu_enabled: options.muFpuEnabled,
      quiescence_enabled: options.quiescenceEnabled,
      quiescence_max_extra_turns: Math.max(0, Math.floor(options.quiescenceMaxExtraTurns)),
      use_static_leaf_eval: options.useStaticLeafEval,
      transpositions_enabled: options.transpositionsEnabled,
      forcing_solver_enabled: options.forcingSolverEnabled,
      max_simulation_turns: Math.max(1, Math.floor(options.maxSimulationTurns)),
      simulation_turn_candidate_count: Math.max(1, Math.floor(options.simulationTurnCandidateCount)),
      simulation_radius: Math.max(1, Math.floor(options.simulationRadius)),
      simulation_top_k_first_moves: Math.max(1, Math.floor(options.simulationTopKFirstMoves)),
    },
    moves: toOrderedMoveArray(state),
  }
}

function toWasmEvaluateRequest(state: LiveLikeState, tuning: BotTuning): WasmEvaluatePositionRequest {
  return {
    tuning: {
      threat_weights: [...tuning.threatWeights],
      threat_breadth_weights: [...tuning.threatBreadthWeights],
      defense_weight: tuning.defenseWeight,
      tempo_discount_per_stone: tuning.tempoDiscountPerStone,
      threat_severity_scale: tuning.threatSeverityScale,
      one_turn_win_bonus: tuning.oneTurnWinBonus,
      one_turn_fork_bonus: tuning.oneTurnForkBonus,
      threat3_cluster_bonus: tuning.threat3ClusterBonus,
      threat4_fork_bonus: tuning.threat4ForkBonus,
      threat5_fork_bonus: tuning.threat5ForkBonus,
      threat3_blocker_bonus: tuning.threat3BlockerBonus,
      active_build_multiplier_one: tuning.activeBuildMultiplierOne,
      active_build_multiplier_two: tuning.activeBuildMultiplierTwo,
      candidate_radius: Math.max(1, Math.floor(tuning.candidateRadius)),
      top_k_first_moves: Math.max(1, Math.floor(tuning.topKFirstMoves)),
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

  const telemetryRaw = response.telemetry
  let telemetry: BotSearchTelemetry | undefined
  if (telemetryRaw && typeof telemetryRaw === 'object') {
    telemetry = {
      rootPriorTopShare: Number.isFinite(Number(telemetryRaw.root_prior_top_share))
        ? Math.max(0, Math.min(1, Number(telemetryRaw.root_prior_top_share)))
        : 0,
      rootBestVisitShare: Number.isFinite(Number(telemetryRaw.root_best_visit_share))
        ? Math.max(0, Math.min(1, Number(telemetryRaw.root_best_visit_share)))
        : 0,
      wideningUnlockCount: Number.isFinite(Number(telemetryRaw.widening_unlock_count))
        ? Math.max(0, Math.floor(Number(telemetryRaw.widening_unlock_count)))
        : 0,
      muFpuSelectionCount: Number.isFinite(Number(telemetryRaw.mu_fpu_selection_count))
        ? Math.max(0, Math.floor(Number(telemetryRaw.mu_fpu_selection_count)))
        : 0,
      quiescenceCallCount: Number.isFinite(Number(telemetryRaw.quiescence_call_count))
        ? Math.max(0, Math.floor(Number(telemetryRaw.quiescence_call_count)))
        : 0,
      quiescenceExtensionCount: Number.isFinite(Number(telemetryRaw.quiescence_extension_count))
        ? Math.max(0, Math.floor(Number(telemetryRaw.quiescence_extension_count)))
        : 0,
      transpositionHits: Number.isFinite(Number(telemetryRaw.transposition_hits))
        ? Math.max(0, Math.floor(Number(telemetryRaw.transposition_hits)))
        : 0,
      transpositionMisses: Number.isFinite(Number(telemetryRaw.transposition_misses))
        ? Math.max(0, Math.floor(Number(telemetryRaw.transposition_misses)))
        : 0,
      transpositionStores: Number.isFinite(Number(telemetryRaw.transposition_stores))
        ? Math.max(0, Math.floor(Number(telemetryRaw.transposition_stores)))
        : 0,
      transpositionReuses: Number.isFinite(Number(telemetryRaw.transposition_reuses))
        ? Math.max(0, Math.floor(Number(telemetryRaw.transposition_reuses)))
        : 0,
      transpositionTableSize: Number.isFinite(Number(telemetryRaw.transposition_table_size))
        ? Math.max(0, Math.floor(Number(telemetryRaw.transposition_table_size)))
        : 0,
    }
  }

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
      telemetry,
    },
  }
}

function buildWasmPositionEvaluation(response: WasmEvaluatePositionResponse): BotPositionEvaluation | null {
  const xScore = Number(response.x_score)
  const oScore = Number(response.o_score)
  const objectiveForX = Number(response.objective_for_x)
  const objectiveForO = Number(response.objective_for_o)

  if (!Number.isFinite(xScore) || !Number.isFinite(oScore) || !Number.isFinite(objectiveForX) || !Number.isFinite(objectiveForO)) {
    return null
  }

  return {
    xScore,
    oScore,
    xNextTurnFinishGroups: Number.isFinite(Number(response.x_next_turn_finish_groups))
      ? Math.max(0, Math.floor(Number(response.x_next_turn_finish_groups)))
      : 0,
    oNextTurnFinishGroups: Number.isFinite(Number(response.o_next_turn_finish_groups))
      ? Math.max(0, Math.floor(Number(response.o_next_turn_finish_groups)))
      : 0,
    xNextTurnBlockersRequired: Number.isFinite(Number(response.x_next_turn_blockers_required))
      ? Math.max(0, Math.floor(Number(response.x_next_turn_blockers_required)))
      : 0,
    oNextTurnBlockersRequired: Number.isFinite(Number(response.o_next_turn_blockers_required))
      ? Math.max(0, Math.floor(Number(response.o_next_turn_blockers_required)))
      : 0,
    xForcedNextTurn: Boolean(response.x_forced_next_turn),
    oForcedNextTurn: Boolean(response.o_forced_next_turn),
    objectiveForX,
    objectiveForO,
  }
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

function tryChooseTurnFromLoadedWasm(
  state: LiveLikeState,
  tuning: BotTuning,
  partialOptions: Partial<BotSearchOptions>,
): BotTurnDecision | null {
  if (!wasmModuleRef?.choose_turn_json) return null

  const options = normalizeSearchOptions(partialOptions)
  const request = toWasmTurnRequest(state, options, tuning)
  const startMs = nowMs()

  try {
    const raw = wasmModuleRef.choose_turn_json(JSON.stringify(request))
    const parsed = JSON.parse(raw) as WasmTurnResponse
    if (parsed.error) {
      wasmRuntimeStatus = 'failed'
      wasmRuntimeMessage = `WASM bot error: ${parsed.error} (moves=${request.moves.length}, turn=${request.turn}, placements=${request.placements_left}, budget=${request.max_time_ms}ms/${request.max_nodes}n)`
      return null
    }
    return buildWasmDecision(state, parsed, Math.max(0, nowMs() - startMs))
  } catch (error) {
    wasmRuntimeStatus = 'failed'
    const errMsg = error instanceof Error ? error.message : String(error)
    wasmRuntimeMessage =
      `WASM bot execution failed: ${errMsg} (moves=${request.moves.length}, turn=${request.turn}, placements=${request.placements_left}, budget=${request.max_time_ms}ms/${request.max_nodes}n)`
    console.error('[WASM bot] sync execution error', error)
    return null
  }
}

async function tryChooseTurnFromWasm(
  state: LiveLikeState,
  tuning: BotTuning,
  partialOptions: Partial<BotSearchOptions>,
): Promise<BotTurnDecision | null> {
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
      wasmRuntimeMessage = `WASM bot error: ${parsed.error} (moves=${request.moves.length}, turn=${request.turn}, placements=${request.placements_left}, budget=${request.max_time_ms}ms/${request.max_nodes}n)`
      return null
    }
    return buildWasmDecision(state, parsed, Math.max(0, nowMs() - startMs))
  } catch (error) {
    wasmRuntimeStatus = 'failed'
    const errMsg = error instanceof Error ? error.message : String(error)
    wasmRuntimeMessage =
      `WASM bot execution failed: ${errMsg} (moves=${request.moves.length}, turn=${request.turn}, placements=${request.placements_left}, budget=${request.max_time_ms}ms/${request.max_nodes}n)`
    console.error('[WASM bot] execution error', error)
    return null
  }
}

async function tryEvaluatePositionFromWasm(
  state: LiveLikeState,
  tuning: BotTuning,
): Promise<BotPositionEvaluation | null> {
  const module = await loadWasmModule()
  if (!module?.evaluate_position_json) return null

  const request = toWasmEvaluateRequest(state, tuning)

  try {
    const raw = module.evaluate_position_json(JSON.stringify(request))
    const parsed = JSON.parse(raw) as WasmEvaluatePositionResponse
    if (parsed.error) {
      wasmRuntimeStatus = 'failed'
      wasmRuntimeMessage = `WASM eval error: ${parsed.error} (moves=${request.moves.length})`
      return null
    }
    return buildWasmPositionEvaluation(parsed)
  } catch (error) {
    wasmRuntimeStatus = 'failed'
    const errMsg = error instanceof Error ? error.message : String(error)
    wasmRuntimeMessage = `WASM eval execution failed: ${errMsg} (moves=${request.moves.length})`
    console.error('[WASM bot] eval execution error', error)
    return null
  }
}

export function createBotSearchSession(): BotSearchSession {
  return { runs: 0 }
}

export function getPreferredBotBackend(): BotBackend {
  return 'wasm'
}

export function setPreferredBotBackend(_backend: BotBackend): void {
  void _backend
  // WASM is always enforced.
}

export function getEffectiveBotBackend(): BotBackend {
  return 'wasm'
}

export function getWasmBotRuntimeStatus(): WasmBotRuntimeStatus {
  return wasmRuntimeStatus
}

export function getWasmBotRuntimeMessage(): string | null {
  return wasmRuntimeMessage
}

export async function warmupWasmBot(): Promise<boolean> {
  const module = await loadWasmModule()
  return Boolean(module?.choose_turn_json)
}

export async function evaluateBotPosition(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
): Promise<BotPositionEvaluation> {
  const evaluation = await tryEvaluatePositionFromWasm(state, tuning)
  if (!evaluation) {
    throw createWasmUnavailableError()
  }
  return evaluation
}

export function chooseBotTurnDetailedWithSession(
  state: LiveLikeState,
  session: BotSearchSession,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotTurnDecision {
  const wasmDecision = tryChooseTurnFromLoadedWasm(state, tuning, partialOptions)
  if (!wasmDecision) {
    throw createWasmUnavailableError()
  }
  session.runs += 1
  return wasmDecision
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
  if (!wasmDecision) {
    throw createWasmUnavailableError()
  }
  session.runs += 1
  progressOptions.onProgress?.({
    elapsedMs: wasmDecision.stats.elapsedMs,
    nodesExpanded: wasmDecision.stats.nodesExpanded,
    playouts: wasmDecision.stats.playouts,
    boardEvaluations: wasmDecision.stats.boardEvaluations,
    maxDepthTurns: wasmDecision.stats.maxDepthTurns,
  })
  return wasmDecision
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
  return chooseBotTurnDetailed(state, tuning, {
    budget: {
      maxTimeMs: 0,
      maxNodes: 0,
    },
  }).moves
}

export function chooseBotTurnWithJsFallback(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): Axial[] {
  return chooseBotTurn(state, tuning, partialOptions)
}
