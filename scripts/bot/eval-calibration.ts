import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BOT_TUNING, type Player } from '../../src/bot/types.ts'

type AnalysisMode = 'anchor' | 'precursor'

type BotModule = {
  evaluate_position_json(inputJson: string): string
}

type CalibrationOptions = {
  mode: AnalysisMode
  datasetPaths: string[]
  tuningFilePath: string | null
  states: number
  precursorMinPlies: number
  precursorMaxPlies: number
  allowDirty: boolean
  limit: number | null
  includeLabels: Set<string> | null
  excludeLabels: Set<string>
  examples: number
}

type NormalizedMove = {
  q: number
  r: number
  mark: Player
}

type NormalizedGame = {
  source: string
  gameId: string
  resultReason: string
  label: string
  winnerMark: Player
  anchorMoveCount: number
  moves: NormalizedMove[]
}

type EvaluationResponse = {
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
  x_one_turn_wins?: number
  o_one_turn_wins?: number
  error?: string
}

type WasmTuningRequest = {
  threat_weights: number[]
  defense_weight: number
  tempo_discount_per_stone: number
  threat_severity_scale: number
  active_build_multiplier_one: number
  active_build_multiplier_two: number
  candidate_radius: number
  top_k_first_moves: number
}

type TuningOverrideInput = Partial<WasmTuningRequest> & {
  threatWeights?: number[]
  defenseWeight?: number
  tempoDiscountPerStone?: number
  threatSeverityScale?: number
  activeBuildMultiplierOne?: number
  activeBuildMultiplierTwo?: number
  candidateRadius?: number
  topKFirstMoves?: number
}

type PositionMetrics = {
  xScore: number
  oScore: number
  objectiveForX: number
  objectiveForO: number
  xNextTurnFinishGroups: number
  oNextTurnFinishGroups: number
  xNextTurnBlockersRequired: number
  oNextTurnBlockersRequired: number
  xForcedNextTurn: boolean
  oForcedNextTurn: boolean
}

type SampleResult = {
  mode: AnalysisMode
  source: string
  label: string
  gameId: string
  resultReason: string
  winnerMark: Player
  sampledMoveCount: number
  bucketDistance: number
  anchorMoveCount?: number
  forceMoveCount?: number
  winnerScore: number
  loserScore: number
  gap: number
  winnerObjective: number
  loserObjective: number
  winnerNextTurnFinishGroups: number
  loserNextTurnFinishGroups: number
  winnerNextTurnBlockersRequired: number
  loserNextTurnBlockersRequired: number
  winnerForcedNextTurn: boolean
  loserForcedNextTurn: boolean
}

type AggregateBucket = {
  source: string
  label: string
  bucketDistance: number
  total: number
  winnerHigher: number
  ties: number
  loserHigher: number
  gaps: number[]
}

type TurnState = {
  turn: Player
  placementsLeft: number
}

type TurnStartDiagnostic = {
  count: number
  toMove: Player
  terminal: boolean
  metrics: PositionMetrics
}

type PrecursorAnalysis = {
  forceMoveCount: number | null
  dirtySkipped: number
  samples: SampleResult[]
}

type ArchiveClassificationRow = {
  gameId?: string
  resultReason?: string
  moves?: Array<{ x?: number; y?: number; player?: string }>
  classification?: {
    label?: string
    winnerMark?: string
    referencePlyCount?: number
  }
}

type HexoTacticsGame = {
  id?: string
  gameResult?: {
    winningPlayerId?: string
    reason?: string
  }
  moves?: Array<{
    x?: number
    y?: number
    playerId?: string
  }>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')
const DEFAULT_ARCHIVE_DATASET = path.join(
  REPO_ROOT,
  'datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/endgame-classification/classifications.jsonl',
)
const DEFAULT_HEXO_TACTICS_DATASET = path.join(REPO_ROOT, '.external-repos/hexo-tactics/data/games.json')

function defaultWasmTuning(): WasmTuningRequest {
  return {
    threat_weights: [...DEFAULT_BOT_TUNING.threatWeights],
    defense_weight: DEFAULT_BOT_TUNING.defenseWeight,
    tempo_discount_per_stone: DEFAULT_BOT_TUNING.tempoDiscountPerStone,
    threat_severity_scale: DEFAULT_BOT_TUNING.threatSeverityScale,
    active_build_multiplier_one: DEFAULT_BOT_TUNING.activeBuildMultiplierOne,
    active_build_multiplier_two: DEFAULT_BOT_TUNING.activeBuildMultiplierTwo,
    candidate_radius: DEFAULT_BOT_TUNING.candidateRadius,
    top_k_first_moves: DEFAULT_BOT_TUNING.topKFirstMoves,
  }
}

function asNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function asNumberArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }
  const next = value.map((entry) => asNumber(entry)).filter((entry): entry is number => entry !== null)
  return next.length === 0 ? [...fallback] : next
}

function loadTuningOverrides(tuningFilePath: string | null): TuningOverrideInput | null {
  if (!tuningFilePath) {
    return null
  }

  const raw = readFileSync(tuningFilePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected tuning JSON object in ${tuningFilePath}`)
  }
  return parsed as TuningOverrideInput
}

function buildWasmTuning(overrides: TuningOverrideInput | null): WasmTuningRequest {
  const fallback = defaultWasmTuning()
  const tuning = overrides ?? {}

  return {
    threat_weights: asNumberArray(tuning.threat_weights ?? tuning.threatWeights, fallback.threat_weights),
    defense_weight: asNumber(tuning.defense_weight ?? tuning.defenseWeight) ?? fallback.defense_weight,
    tempo_discount_per_stone:
      asNumber(tuning.tempo_discount_per_stone ?? tuning.tempoDiscountPerStone) ?? fallback.tempo_discount_per_stone,
    threat_severity_scale:
      asNumber(tuning.threat_severity_scale ?? tuning.threatSeverityScale) ?? fallback.threat_severity_scale,
    active_build_multiplier_one:
      asNumber(
        (tuning as TuningOverrideInput & { active_build_multiplier_one?: number }).active_build_multiplier_one ??
          tuning.activeBuildMultiplierOne,
      ) ?? fallback.active_build_multiplier_one,
    active_build_multiplier_two:
      asNumber(
        (tuning as TuningOverrideInput & { active_build_multiplier_two?: number }).active_build_multiplier_two ??
          tuning.activeBuildMultiplierTwo,
      ) ?? fallback.active_build_multiplier_two,
    candidate_radius: asNumber(tuning.candidate_radius ?? tuning.candidateRadius) ?? fallback.candidate_radius,
    top_k_first_moves: asNumber(tuning.top_k_first_moves ?? tuning.topKFirstMoves) ?? fallback.top_k_first_moves,
  }
}

function parseArgs(argv: string[]): CalibrationOptions {
  const datasetPaths: string[] = []
  let mode: AnalysisMode = 'precursor'
  let tuningFilePath: string | null = null
  let states = 3
  let precursorMinPlies = 3
  let precursorMaxPlies = 5
  let allowDirty = false
  let limit: number | null = null
  let includeLabels: Set<string> | null = null
  const excludeLabels = new Set<string>()
  let examples = 5

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx]
    const next = argv[idx + 1]

    if (arg === '--mode' && next) {
      if (next !== 'anchor' && next !== 'precursor') {
        throw new Error(`Unknown mode '${next}'. Expected 'anchor' or 'precursor'.`)
      }
      mode = next
      idx += 1
      continue
    }
    if (arg === '--dataset' && next) {
      datasetPaths.push(path.resolve(REPO_ROOT, next))
      idx += 1
      continue
    }
    if (arg === '--tuning-file' && next) {
      tuningFilePath = path.resolve(REPO_ROOT, next)
      idx += 1
      continue
    }
    if (arg === '--states' && next) {
      states = Math.max(1, Math.min(3, Math.floor(Number(next) || 0)))
      idx += 1
      continue
    }
    if (arg === '--precursor-min-plies' && next) {
      precursorMinPlies = Math.max(1, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }
    if (arg === '--precursor-max-plies' && next) {
      precursorMaxPlies = Math.max(1, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }
    if (arg === '--allow-dirty') {
      allowDirty = true
      continue
    }
    if (arg === '--limit' && next) {
      limit = Math.max(1, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }
    if (arg === '--include-label' && next) {
      includeLabels ??= new Set<string>()
      includeLabels.add(next.trim())
      idx += 1
      continue
    }
    if (arg === '--exclude-label' && next) {
      excludeLabels.add(next.trim())
      idx += 1
      continue
    }
    if (arg === '--examples' && next) {
      examples = Math.max(0, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }

    throw new Error(`Unknown argument '${arg}'`)
  }

  if (precursorMinPlies > precursorMaxPlies) {
    const temp = precursorMinPlies
    precursorMinPlies = precursorMaxPlies
    precursorMaxPlies = temp
  }

  if (datasetPaths.length === 0) {
    if (existsSync(DEFAULT_ARCHIVE_DATASET)) datasetPaths.push(DEFAULT_ARCHIVE_DATASET)
    if (existsSync(DEFAULT_HEXO_TACTICS_DATASET)) datasetPaths.push(DEFAULT_HEXO_TACTICS_DATASET)
  }

  if (datasetPaths.length === 0) {
    throw new Error('No datasets found. Pass one or more --dataset paths.')
  }

  return {
    mode,
    datasetPaths,
    tuningFilePath,
    states,
    precursorMinPlies,
    precursorMaxPlies,
    allowDirty,
    limit,
    includeLabels,
    excludeLabels,
    examples,
  }
}

function runCommand(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
    },
  })

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function getWasmBindgenDir(): string {
  const home = process.env.HOME
  if (!home) {
    throw new Error('HOME is not set')
  }

  const wasmPackCache = path.join(home, '.cache/.wasm-pack')
  const entries = readdirSync(wasmPackCache, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('wasm-bindgen-'))?.name
  if (!match) {
    throw new Error(`No cached wasm-bindgen directory found in ${wasmPackCache}`)
  }
  return path.join(wasmPackCache, match)
}

function buildNodeBotPackage(): { pkgDir: string; cleanup: () => void } {
  const home = process.env.HOME
  if (!home) {
    throw new Error('HOME is not set')
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'hex-ttt-eval-'))
  const pkgDir = path.join(tempRoot, 'bot')
  const bindgenDir = getWasmBindgenDir()
  const env = {
    PATH: [bindgenDir, path.join(home, '.cargo/bin'), process.env.PATH ?? ''].join(':'),
  }

  runCommand(
    'wasm-pack',
    [
      'build',
      'wasm-bot',
      '--mode',
      'no-install',
      '--target',
      'nodejs',
      '--no-opt',
      '--out-dir',
      pkgDir,
      '--out-name',
      'hex_ttt_wasm',
    ],
    REPO_ROOT,
    env,
  )

  return {
    pkgDir,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  }
}

function loadBotModule(pkgDir: string): BotModule {
  const require = createRequire(import.meta.url)
  const modulePath = path.join(pkgDir, 'hex_ttt_wasm.js')
  return require(modulePath) as BotModule
}

function deriveActorMarks<T>(moves: T[], actorForMove: (move: T) => string | null): Map<string, Player> {
  const actorMarks = new Map<string, Player>()
  for (const move of moves) {
    const actor = actorForMove(move)
    if (!actor || actorMarks.has(actor)) continue
    actorMarks.set(actor, actorMarks.size === 0 ? 'X' : 'O')
  }
  return actorMarks
}

function inferAnchorMoveCount(resultReason: string, moveCount: number): number {
  if (resultReason === 'six-in-a-row') {
    const turnStarts = enumerateTurnStartCounts(moveCount)
    return turnStarts.length === 0 ? 0 : turnStarts[turnStarts.length - 1]
  }
  return moveCount
}

function normalizeArchiveRow(row: ArchiveClassificationRow): NormalizedGame | null {
  const rawMoves = Array.isArray(row.moves) ? row.moves : []
  if (rawMoves.length === 0) return null

  const winnerMarkRaw = row.classification?.winnerMark
  const winnerMark = winnerMarkRaw === 'X' || winnerMarkRaw === 'O' ? winnerMarkRaw : null
  if (!winnerMark) return null

  const actorMarks = deriveActorMarks(rawMoves, (move) => (typeof move.player === 'string' ? move.player : null))
  if (actorMarks.size < 2) return null

  const moves: NormalizedMove[] = []
  for (const move of rawMoves) {
    const q = Number(move.x)
    const r = Number(move.y)
    const actor = typeof move.player === 'string' ? move.player : null
    const mark = actor ? actorMarks.get(actor) : undefined
    if (!Number.isInteger(q) || !Number.isInteger(r) || !mark) {
      return null
    }
    moves.push({ q, r, mark })
  }

  const resultReason = typeof row.resultReason === 'string' ? row.resultReason : 'unknown'
  const anchorMoveCountRaw = Number(row.classification?.referencePlyCount)
  const anchorMoveCount = Number.isInteger(anchorMoveCountRaw)
    ? Math.max(0, Math.min(moves.length, anchorMoveCountRaw))
    : inferAnchorMoveCount(resultReason, moves.length)

  return {
    source: 'hexo-archive',
    gameId: typeof row.gameId === 'string' ? row.gameId : 'unknown',
    resultReason,
    label: typeof row.classification?.label === 'string' ? row.classification.label : 'unclassified',
    winnerMark,
    anchorMoveCount,
    moves,
  }
}

function normalizeHexoTacticsGame(game: HexoTacticsGame): NormalizedGame | null {
  const rawMoves = Array.isArray(game.moves) ? game.moves : []
  if (rawMoves.length === 0) return null

  const actorMarks = deriveActorMarks(rawMoves, (move) => (typeof move.playerId === 'string' ? move.playerId : null))
  if (actorMarks.size < 2) return null

  const winnerPlayerId = game.gameResult?.winningPlayerId
  const winnerMark = typeof winnerPlayerId === 'string' ? actorMarks.get(winnerPlayerId) : undefined
  if (!winnerMark) return null

  const moves: NormalizedMove[] = []
  for (const move of rawMoves) {
    const q = Number(move.x)
    const r = Number(move.y)
    const actor = typeof move.playerId === 'string' ? move.playerId : null
    const mark = actor ? actorMarks.get(actor) : undefined
    if (!Number.isInteger(q) || !Number.isInteger(r) || !mark) {
      return null
    }
    moves.push({ q, r, mark })
  }

  const resultReason = typeof game.gameResult?.reason === 'string' ? game.gameResult.reason : 'unknown'

  return {
    source: 'hexo-tactics',
    gameId: typeof game.id === 'string' ? game.id : 'unknown',
    resultReason,
    label: 'unclassified',
    winnerMark,
    anchorMoveCount: inferAnchorMoveCount(resultReason, moves.length),
    moves,
  }
}

function loadDataset(datasetPath: string): NormalizedGame[] {
  const raw = readFileSync(datasetPath, 'utf8')

  if (datasetPath.endsWith('.jsonl')) {
    return raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeArchiveRow(JSON.parse(line) as ArchiveClassificationRow))
      .filter((value): value is NormalizedGame => value !== null)
  }

  if (datasetPath.endsWith('.json')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array in ${datasetPath}`)
    }
    return parsed
      .map((entry) => normalizeHexoTacticsGame(entry as HexoTacticsGame))
      .filter((value): value is NormalizedGame => value !== null)
  }

  throw new Error(`Unsupported dataset format for ${datasetPath}`)
}

function opponent(player: Player): Player {
  return player === 'X' ? 'O' : 'X'
}

function deriveTurnState(totalMoves: number): TurnState {
  if (totalMoves <= 0) {
    return { turn: 'X', placementsLeft: 1 }
  }
  if (totalMoves === 1) {
    return { turn: 'O', placementsLeft: 2 }
  }
  const k = totalMoves - 1
  const turnIndex = Math.floor(k / 2)
  return {
    turn: turnIndex % 2 === 0 ? 'O' : 'X',
    placementsLeft: k % 2 === 0 ? 2 : 1,
  }
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function findWinner(moves: Map<string, Player>): Player | null {
  const directions: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [1, -1],
  ]

  for (const [key, mark] of moves.entries()) {
    const [qRaw, rRaw] = key.split(',')
    const q = Number(qRaw)
    const r = Number(rRaw)
    if (!Number.isInteger(q) || !Number.isInteger(r)) {
      continue
    }

    for (const [dq, dr] of directions) {
      let count = 1

      let cq = q + dq
      let cr = r + dr
      while (moves.get(toKey(cq, cr)) === mark) {
        count += 1
        cq += dq
        cr += dr
      }

      cq = q - dq
      cr = r - dr
      while (moves.get(toKey(cq, cr)) === mark) {
        count += 1
        cq -= dq
        cr -= dr
      }

      if (count >= 6) {
        return mark
      }
    }
  }

  return null
}

function enumerateTurnStartCounts(totalMoves: number): number[] {
  const counts: number[] = []
  let movesPlayed = 0
  let placementsThisTurn = 1

  while (movesPlayed < totalMoves) {
    movesPlayed += placementsThisTurn
    if (movesPlayed < totalMoves) {
      counts.push(movesPlayed)
    }
    placementsThisTurn = 2
  }

  return counts
}

function sampleAnchorMoveCounts(anchorMoveCount: number, totalMoves: number, states: number): number[] {
  const sampled = [Math.max(0, Math.min(totalMoves, anchorMoveCount))]
  const earlierTurnStarts = enumerateTurnStartCounts(totalMoves)
    .filter((count) => count < sampled[0])
    .reverse()

  for (const count of earlierTurnStarts) {
    if (sampled.length >= states) break
    sampled.push(count)
  }

  return sampled
}

function evaluatePosition(bot: BotModule, moves: NormalizedMove[], tuning: WasmTuningRequest): PositionMetrics {
  const request = {
    tuning,
    moves: moves.map((move) => ({
      q: move.q,
      r: move.r,
      mark: move.mark,
    })),
  }

  const raw = bot.evaluate_position_json(JSON.stringify(request))
  const parsed = JSON.parse(raw) as EvaluationResponse
  if (parsed.error) {
    throw new Error(parsed.error)
  }

  const xNextTurnFinishGroups = Math.max(
    0,
    Math.floor(Number(parsed.x_next_turn_finish_groups ?? parsed.x_one_turn_wins ?? 0)),
  )
  const oNextTurnFinishGroups = Math.max(
    0,
    Math.floor(Number(parsed.o_next_turn_finish_groups ?? parsed.o_one_turn_wins ?? 0)),
  )
  const xNextTurnBlockersRequired = Math.max(0, Math.floor(Number(parsed.x_next_turn_blockers_required ?? 0)))
  const oNextTurnBlockersRequired = Math.max(0, Math.floor(Number(parsed.o_next_turn_blockers_required ?? 0)))

  return {
    xScore: Number(parsed.x_score ?? 0),
    oScore: Number(parsed.o_score ?? 0),
    objectiveForX: Number(parsed.objective_for_x ?? 0),
    objectiveForO: Number(parsed.objective_for_o ?? 0),
    xNextTurnFinishGroups,
    oNextTurnFinishGroups,
    xNextTurnBlockersRequired,
    oNextTurnBlockersRequired,
    xForcedNextTurn: Boolean(parsed.x_forced_next_turn ?? xNextTurnBlockersRequired >= 3),
    oForcedNextTurn: Boolean(parsed.o_forced_next_turn ?? oNextTurnBlockersRequired >= 3),
  }
}

function createMetricsGetter(
  bot: BotModule,
  game: NormalizedGame,
  tuning: WasmTuningRequest,
): (moveCount: number) => PositionMetrics {
  const cache = new Map<number, PositionMetrics>()

  return (moveCount: number): PositionMetrics => {
    const normalizedMoveCount = Math.max(0, Math.min(game.moves.length, Math.floor(moveCount)))
    const cached = cache.get(normalizedMoveCount)
    if (cached) {
      return cached
    }

    const metrics = evaluatePosition(bot, game.moves.slice(0, normalizedMoveCount), tuning)
    cache.set(normalizedMoveCount, metrics)
    return metrics
  }
}

function metricsForPlayer(metrics: PositionMetrics, player: Player): {
  score: number
  objective: number
  nextTurnFinishGroups: number
  nextTurnBlockersRequired: number
  forcedNextTurn: boolean
} {
  if (player === 'X') {
    return {
      score: metrics.xScore,
      objective: metrics.objectiveForX,
      nextTurnFinishGroups: metrics.xNextTurnFinishGroups,
      nextTurnBlockersRequired: metrics.xNextTurnBlockersRequired,
      forcedNextTurn: metrics.xForcedNextTurn,
    }
  }

  return {
    score: metrics.oScore,
    objective: metrics.objectiveForO,
    nextTurnFinishGroups: metrics.oNextTurnFinishGroups,
    nextTurnBlockersRequired: metrics.oNextTurnBlockersRequired,
    forcedNextTurn: metrics.oForcedNextTurn,
  }
}

function buildSampleResult(
  game: NormalizedGame,
  metrics: PositionMetrics,
  sampledMoveCount: number,
  mode: AnalysisMode,
  bucketDistance: number,
  extra: {
    anchorMoveCount?: number
    forceMoveCount?: number
  } = {},
): SampleResult {
  const winner = metricsForPlayer(metrics, game.winnerMark)
  const loser = metricsForPlayer(metrics, opponent(game.winnerMark))

  return {
    mode,
    source: game.source,
    label: game.label,
    gameId: game.gameId,
    resultReason: game.resultReason,
    winnerMark: game.winnerMark,
    sampledMoveCount,
    bucketDistance,
    anchorMoveCount: extra.anchorMoveCount,
    forceMoveCount: extra.forceMoveCount,
    winnerScore: winner.score,
    loserScore: loser.score,
    gap: winner.score - loser.score,
    winnerObjective: winner.objective,
    loserObjective: loser.objective,
    winnerNextTurnFinishGroups: winner.nextTurnFinishGroups,
    loserNextTurnFinishGroups: loser.nextTurnFinishGroups,
    winnerNextTurnBlockersRequired: winner.nextTurnBlockersRequired,
    loserNextTurnBlockersRequired: loser.nextTurnBlockersRequired,
    winnerForcedNextTurn: winner.forcedNextTurn,
    loserForcedNextTurn: loser.forcedNextTurn,
  }
}

function shouldIncludeGame(game: NormalizedGame, options: CalibrationOptions): boolean {
  if (options.includeLabels && !options.includeLabels.has(game.label)) {
    return false
  }
  if (options.excludeLabels.has(game.label)) {
    return false
  }
  return true
}

function makeBucketKey(source: string, label: string, bucketDistance: number): string {
  return `${source}::${label}::${bucketDistance}`
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[idx]
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`
}

function printBucketTable(title: string, buckets: AggregateBucket[], bucketLabel: string): void {
  console.log(`\n${title}`)
  console.log(
    [
      'source'.padEnd(13),
      'label'.padEnd(13),
      bucketLabel.padStart(6),
      'samples'.padStart(7),
      'win>'.padStart(8),
      'lose>'.padStart(8),
      'meanGap'.padStart(10),
      'median'.padStart(10),
      'p10'.padStart(10),
    ].join(' '),
  )

  for (const bucket of buckets) {
    const meanGap = bucket.gaps.reduce((sum, gap) => sum + gap, 0) / bucket.gaps.length
    console.log(
      [
        bucket.source.padEnd(13),
        bucket.label.padEnd(13),
        String(bucket.bucketDistance).padStart(6),
        String(bucket.total).padStart(7),
        formatPercent(bucket.winnerHigher / bucket.total).padStart(8),
        formatPercent(bucket.loserHigher / bucket.total).padStart(8),
        formatSigned(meanGap).padStart(10),
        formatSigned(quantile(bucket.gaps, 0.5)).padStart(10),
        formatSigned(quantile(bucket.gaps, 0.1)).padStart(10),
      ].join(' '),
    )
  }
}

function collectTurnStartDiagnostics(game: NormalizedGame, getMetrics: (moveCount: number) => PositionMetrics): TurnStartDiagnostic[] {
  const diagnostics: TurnStartDiagnostic[] = []
  const board = new Map<string, Player>()
  let nextMoveIdx = 0

  for (let count = 0; count <= game.moves.length; count += 1) {
    while (nextMoveIdx < count) {
      const move = game.moves[nextMoveIdx]
      board.set(toKey(move.q, move.r), move.mark)
      nextMoveIdx += 1
    }

    const state = deriveTurnState(count)
    if (state.placementsLeft !== 2) {
      continue
    }

    diagnostics.push({
      count,
      toMove: state.turn,
      terminal: findWinner(board) !== null,
      metrics: getMetrics(count),
    })
  }

  return diagnostics
}

function findFirstWinnerForcedTurnStart(game: NormalizedGame, diagnostics: TurnStartDiagnostic[]): number | null {
  const loserMark = opponent(game.winnerMark)

  for (const diagnostic of diagnostics) {
    if (diagnostic.terminal) {
      continue
    }
    if (diagnostic.toMove !== loserMark) {
      continue
    }

    const winner = metricsForPlayer(diagnostic.metrics, game.winnerMark)
    const loser = metricsForPlayer(diagnostic.metrics, loserMark)
    if (winner.forcedNextTurn && !loser.forcedNextTurn) {
      return diagnostic.count
    }
  }

  return null
}

function hasDirtyOpponentForcedPath(
  game: NormalizedGame,
  diagnostics: TurnStartDiagnostic[],
  sampledMoveCount: number,
  forceMoveCount: number,
): boolean {
  const loserMark = opponent(game.winnerMark)

  for (const diagnostic of diagnostics) {
    if (diagnostic.count < sampledMoveCount || diagnostic.count >= forceMoveCount) {
      continue
    }
    if (diagnostic.terminal) {
      continue
    }
    if (diagnostic.toMove !== game.winnerMark) {
      continue
    }

    const loser = metricsForPlayer(diagnostic.metrics, loserMark)
    if (loser.forcedNextTurn) {
      return true
    }
  }

  return false
}

function analyzeAnchorGame(
  game: NormalizedGame,
  getMetrics: (moveCount: number) => PositionMetrics,
  options: CalibrationOptions,
): SampleResult[] {
  const sampleCounts = sampleAnchorMoveCounts(game.anchorMoveCount, game.moves.length, options.states)
  return sampleCounts.map((sampledMoveCount, distance) =>
    buildSampleResult(game, getMetrics(sampledMoveCount), sampledMoveCount, 'anchor', distance, {
      anchorMoveCount: game.anchorMoveCount,
    }),
  )
}

function analyzePrecursorGame(
  game: NormalizedGame,
  getMetrics: (moveCount: number) => PositionMetrics,
  options: CalibrationOptions,
): PrecursorAnalysis {
  const diagnostics = collectTurnStartDiagnostics(game, getMetrics)
  const forceMoveCount = findFirstWinnerForcedTurnStart(game, diagnostics)

  if (forceMoveCount === null) {
    return {
      forceMoveCount: null,
      dirtySkipped: 0,
      samples: [],
    }
  }

  let dirtySkipped = 0
  const samples: SampleResult[] = []

  for (let pliesBefore = options.precursorMinPlies; pliesBefore <= options.precursorMaxPlies; pliesBefore += 1) {
    const sampledMoveCount = forceMoveCount - pliesBefore
    if (sampledMoveCount < 0) {
      continue
    }

    if (!options.allowDirty && hasDirtyOpponentForcedPath(game, diagnostics, sampledMoveCount, forceMoveCount)) {
      dirtySkipped += 1
      continue
    }

    samples.push(
      buildSampleResult(game, getMetrics(sampledMoveCount), sampledMoveCount, 'precursor', pliesBefore, {
        forceMoveCount,
      }),
    )
  }

  return {
    forceMoveCount,
    dirtySkipped,
    samples,
  }
}

function printWorstMisses(results: SampleResult[], examples: number, mode: AnalysisMode): void {
  if (examples <= 0) {
    return
  }

  const worstByGame = new Map<string, SampleResult>()

  for (const result of results) {
    if (result.gap >= 0) {
      continue
    }
    const key = `${result.source}::${result.gameId}`
    const previous = worstByGame.get(key)
    if (!previous || result.gap < previous.gap) {
      worstByGame.set(key, result)
    }
  }

  const worst = [...worstByGame.values()]
    .sort((a, b) => a.gap - b.gap)
    .slice(0, examples)

  if (worst.length === 0) {
    return
  }

  console.log(mode === 'precursor' ? '\nWorst unique precursor misses' : '\nWorst unique anchor misses')
  for (const miss of worst) {
    console.log(
      [
        `${miss.source}/${miss.label}`,
        miss.gameId,
        `reason=${miss.resultReason}`,
        mode === 'precursor' ? `force=${miss.forceMoveCount}` : `anchor=${miss.anchorMoveCount}`,
        `sample=${miss.sampledMoveCount}`,
        mode === 'precursor' ? `pliesBefore=${miss.bucketDistance}` : `distance=${miss.bucketDistance}`,
        `gap=${formatSigned(miss.gap)}`,
        `winner=${miss.winnerMark}`,
        `winnerScore=${miss.winnerScore.toFixed(4)}`,
        `loserScore=${miss.loserScore.toFixed(4)}`,
        `winnerFG=${miss.winnerNextTurnFinishGroups}`,
        `loserFG=${miss.loserNextTurnFinishGroups}`,
        `winnerBlockers=${miss.winnerNextTurnBlockersRequired}`,
        `loserBlockers=${miss.loserNextTurnBlockersRequired}`,
      ].join(' | '),
    )
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const loadedGames = options.datasetPaths.flatMap((datasetPath) => loadDataset(datasetPath))
  const uniqueGames = new Map<string, NormalizedGame>()
  for (const game of loadedGames) {
    const key = `${game.source}::${game.gameId}`
    if (!uniqueGames.has(key)) {
      uniqueGames.set(key, game)
    }
  }

  const filteredGames = [...uniqueGames.values()].filter((game) => shouldIncludeGame(game, options))
  const games = options.limit ? filteredGames.slice(0, options.limit) : filteredGames

  if (games.length === 0) {
    throw new Error('No games matched the requested filters.')
  }

  const tuningOverrides = loadTuningOverrides(options.tuningFilePath)
  const wasmTuning = buildWasmTuning(tuningOverrides)
  const { pkgDir, cleanup } = buildNodeBotPackage()
  const bot = loadBotModule(pkgDir)

  try {
    const results: SampleResult[] = []
    let forcedStateGames = 0
    let dirtySkipped = 0

    for (const game of games) {
      const getMetrics = createMetricsGetter(bot, game, wasmTuning)

      if (options.mode === 'anchor') {
        results.push(...analyzeAnchorGame(game, getMetrics, options))
        continue
      }

      const analysis = analyzePrecursorGame(game, getMetrics, options)
      if (analysis.forceMoveCount !== null) {
        forcedStateGames += 1
      }
      dirtySkipped += analysis.dirtySkipped
      results.push(...analysis.samples)
    }

    if (results.length === 0) {
      throw new Error('The selected datasets did not yield any analyzable states.')
    }

    const buckets = new Map<string, AggregateBucket>()
    for (const result of results) {
      const key = makeBucketKey(result.source, result.label, result.bucketDistance)
      const bucket =
        buckets.get(key) ??
        {
          source: result.source,
          label: result.label,
          bucketDistance: result.bucketDistance,
          total: 0,
          winnerHigher: 0,
          ties: 0,
          loserHigher: 0,
          gaps: [],
        }

      bucket.total += 1
      if (result.gap > 0) bucket.winnerHigher += 1
      else if (result.gap < 0) bucket.loserHigher += 1
      else bucket.ties += 1
      bucket.gaps.push(result.gap)
      buckets.set(key, bucket)
    }

    const bucketList = [...buckets.values()].sort((a, b) => {
      if (a.bucketDistance !== b.bucketDistance) return a.bucketDistance - b.bucketDistance
      if (a.source !== b.source) return a.source.localeCompare(b.source)
      return a.label.localeCompare(b.label)
    })

    console.log(`Mode: ${options.mode}`)
    console.log(`Evaluated ${results.length} states from ${games.length} unique games.`)
    if (loadedGames.length !== uniqueGames.size) {
      console.log(`Deduped ${loadedGames.length - uniqueGames.size} duplicate source/gameId rows before sampling.`)
    }
    console.log(`Datasets: ${options.datasetPaths.map((datasetPath) => path.relative(REPO_ROOT, datasetPath)).join(', ')}`)
    if (options.tuningFilePath) {
      console.log(`Tuning: ${path.relative(REPO_ROOT, options.tuningFilePath)}`)
    }

    if (options.mode === 'anchor') {
      console.log(`Anchor states per game: ${options.states}`)
      printBucketTable('Winner Score Ordering By Anchor Slice', bucketList, 'dist')
    } else {
      console.log(`Precursor range: ${options.precursorMinPlies}-${options.precursorMaxPlies} placements before first clean forced-next-turn state`)
      console.log(`Games with a winner forced-next-turn state: ${forcedStateGames}/${games.length}`)
      if (!options.allowDirty) {
        console.log(`Skipped ${dirtySkipped} dirty precursor samples where the loser also had a forcing claim in the path.`)
      }
      printBucketTable('Winner Score Ordering Before First Forced-Next-Turn State', bucketList, 'plies')
    }

    printWorstMisses(results, options.examples, options.mode)
  } finally {
    cleanup()
  }
}

main()
