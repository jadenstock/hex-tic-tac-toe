import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BOT_TUNING, type BotSearchOptions, type Player } from '../../src/bot/types.ts'

type SearchProfileName = keyof typeof SEARCH_PROFILES

type ArenaOptions = {
  baselineRef: string
  candidateRef: string
  profile: SearchProfileName
  openingMoves: number
  openingCount: number
  maxTurns: number
  seed: number
  datasetPath: string
}

type DatasetMove = {
  x: number
  y: number
}

type DatasetGame = {
  gameId: string
  moveCount: number
  moves: DatasetMove[]
}

type MoveRecord = {
  q: number
  r: number
  mark: Player
}

type LiveState = {
  moves: Map<string, Player>
  moveHistory: MoveRecord[]
  turn: Player
  placementsLeft: number
  winner: Player | null
}

type BotModule = {
  choose_turn_json(inputJson: string): string
}

type BotKey = 'candidate' | 'baseline'

type MatchOutcome = {
  winnerBot: BotKey | null
  winnerMark: Player | null
  reason: 'win' | 'invalid' | 'no-result'
  turnsPlayed: number
}

type ScoreBucket = {
  wins: number
  losses: number
  noResults: number
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')
const DEFAULT_DATASET_PATH = path.join(
  REPO_ROOT,
  'datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/games.jsonl',
)

const DEFAULT_SEARCH_OPTIONS: Pick<
  BotSearchOptions,
  | 'explorationC'
  | 'turnCandidateCount'
  | 'childTurnCandidateCount'
  | 'maxSimulationTurns'
  | 'simulationTurnCandidateCount'
  | 'simulationRadius'
  | 'simulationTopKFirstMoves'
> = {
  explorationC: 1.15,
  turnCandidateCount: 24,
  childTurnCandidateCount: 18,
  maxSimulationTurns: 4,
  simulationTurnCandidateCount: 8,
  simulationRadius: 6,
  simulationTopKFirstMoves: 6,
}

const SEARCH_PROFILES = {
  'current-live': {
    budget: {
      maxTimeMs: 2000,
      maxNodes: 175000,
    },
    ...DEFAULT_SEARCH_OPTIONS,
    maxSimulationTurns: 4,
  },
  'previous-live': {
    budget: {
      maxTimeMs: 2000,
      maxNodes: 175000,
    },
    ...DEFAULT_SEARCH_OPTIONS,
    maxSimulationTurns: 6,
  },
} satisfies Record<string, BotSearchOptions>

const DEFAULT_OPENING_MOVES = 3
const DEFAULT_OPENING_COUNT = 8
const DEFAULT_MAX_TURNS = 40

function parseArgs(argv: string[]): ArenaOptions {
  const options: ArenaOptions = {
    baselineRef: 'HEAD~1',
    candidateRef: 'HEAD',
    profile: 'current-live',
    // Default to shallow human openings so the arena gets opening variety
    // without inheriting much human midgame bias.
    openingMoves: DEFAULT_OPENING_MOVES,
    openingCount: DEFAULT_OPENING_COUNT,
    maxTurns: DEFAULT_MAX_TURNS,
    seed: 1,
    datasetPath: DEFAULT_DATASET_PATH,
  }

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx]
    const next = argv[idx + 1]

    if (arg === '--baseline-ref' && next) {
      options.baselineRef = next
      idx += 1
      continue
    }
    if (arg === '--candidate-ref' && next) {
      options.candidateRef = next
      idx += 1
      continue
    }
    if (arg === '--profile' && next) {
      if (!(next in SEARCH_PROFILES)) {
        throw new Error(`Unknown profile '${next}'. Expected one of: ${Object.keys(SEARCH_PROFILES).join(', ')}`)
      }
      options.profile = next as SearchProfileName
      idx += 1
      continue
    }
    if (arg === '--opening-moves' && next) {
      options.openingMoves = Math.max(1, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }
    if (arg === '--openings' && next) {
      options.openingCount = Math.max(1, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }
    if (arg === '--max-turns' && next) {
      options.maxTurns = Math.max(1, Math.floor(Number(next) || 0))
      idx += 1
      continue
    }
    if (arg === '--seed' && next) {
      options.seed = Math.floor(Number(next) || 0)
      idx += 1
      continue
    }
    if (arg === '--dataset' && next) {
      options.datasetPath = path.resolve(REPO_ROOT, next)
      idx += 1
      continue
    }

    throw new Error(`Unknown argument '${arg}'`)
  }

  return options
}

function assertSafeRef(ref: string): void {
  if (!/^[A-Za-z0-9._\-/~^]+$/.test(ref)) {
    throw new Error(`Unsafe git ref '${ref}'`)
  }
}

function runCommand(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
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

  return result.stdout
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getWasmBindgenDir(): string {
  const home = process.env.HOME
  if (!home) {
    throw new Error('HOME is not set')
  }

  const wasmPackCache = path.join(home, '.cache/.wasm-pack')
  const entries = readdirSync(wasmPackCache, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('wasm-bindgen-'))
  if (!match) {
    throw new Error(`No cached wasm-bindgen directory found in ${wasmPackCache}`)
  }
  return path.join(wasmPackCache, match.name)
}

function exportRefToDir(ref: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  runCommand(
    'bash',
    ['-lc', `git archive ${shellQuote(ref)} | tar -x -C ${shellQuote(destDir)}`],
    REPO_ROOT,
  )
}

function buildNodeBot(checkoutDir: string, outDir: string): void {
  const home = process.env.HOME
  if (!home) {
    throw new Error('HOME is not set')
  }

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
      outDir,
      '--out-name',
      'hex_ttt_wasm',
    ],
    checkoutDir,
    env,
  )
}

function loadBotModule(pkgDir: string): BotModule {
  const require = createRequire(import.meta.url)
  const modulePath = path.join(pkgDir, 'hex_ttt_wasm.js')
  return require(modulePath) as BotModule
}

function createRng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let idx = items.length - 1; idx > 0; idx -= 1) {
    const swapIdx = Math.floor(rng() * (idx + 1))
    const temp = items[idx]
    items[idx] = items[swapIdx]
    items[swapIdx] = temp
  }
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function deriveTurnState(totalMoves: number): { turn: Player; placementsLeft: number } {
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

function cloneState(state: LiveState): LiveState {
  return {
    moves: new Map(state.moves),
    moveHistory: state.moveHistory.map((move) => ({ ...move })),
    turn: state.turn,
    placementsLeft: state.placementsLeft,
    winner: state.winner,
  }
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

function createStateFromOpening(opening: MoveRecord[]): LiveState {
  const moves = new Map<string, Player>()
  for (const move of opening) {
    moves.set(toKey(move.q, move.r), move.mark)
  }
  const winner = findWinner(moves)
  const next = deriveTurnState(opening.length)
  return {
    moves,
    moveHistory: opening.map((move) => ({ ...move })),
    turn: next.turn,
    placementsLeft: next.placementsLeft,
    winner,
  }
}

function chooseMoves(bot: BotModule, state: LiveState, options: BotSearchOptions): Array<{ q: number; r: number }> {
  const request = {
    turn: state.turn,
    placements_left: state.placementsLeft,
    max_time_ms: options.budget.maxTimeMs,
    max_nodes: options.budget.maxNodes,
    tuning: {
      threat_weights: [...DEFAULT_BOT_TUNING.threatWeights],
      threat_breadth_weights: [...DEFAULT_BOT_TUNING.threatBreadthWeights],
      defense_weight: DEFAULT_BOT_TUNING.defenseWeight,
      tempo_discount_per_stone: DEFAULT_BOT_TUNING.tempoDiscountPerStone,
      threat_severity_scale: DEFAULT_BOT_TUNING.threatSeverityScale,
      one_turn_win_bonus: DEFAULT_BOT_TUNING.oneTurnWinBonus,
      one_turn_fork_bonus: DEFAULT_BOT_TUNING.oneTurnForkBonus,
      threat3_cluster_bonus: DEFAULT_BOT_TUNING.threat3ClusterBonus,
      threat4_fork_bonus: DEFAULT_BOT_TUNING.threat4ForkBonus,
      threat5_fork_bonus: DEFAULT_BOT_TUNING.threat5ForkBonus,
      threat3_blocker_bonus: DEFAULT_BOT_TUNING.threat3BlockerBonus,
      active_build_multiplier_one: DEFAULT_BOT_TUNING.activeBuildMultiplierOne,
      active_build_multiplier_two: DEFAULT_BOT_TUNING.activeBuildMultiplierTwo,
      candidate_radius: DEFAULT_BOT_TUNING.candidateRadius,
      top_k_first_moves: DEFAULT_BOT_TUNING.topKFirstMoves,
    },
    search_options: {
      exploration_c: options.explorationC,
      turn_candidate_count: options.turnCandidateCount,
      child_turn_candidate_count: options.childTurnCandidateCount,
      max_simulation_turns: options.maxSimulationTurns,
      simulation_turn_candidate_count: options.simulationTurnCandidateCount,
      simulation_radius: options.simulationRadius,
      simulation_top_k_first_moves: options.simulationTopKFirstMoves,
    },
    moves: state.moveHistory.map((move) => ({
      q: move.q,
      r: move.r,
      mark: move.mark,
    })),
  }

  const raw = bot.choose_turn_json(JSON.stringify(request))
  const parsed = JSON.parse(raw) as { error?: string; moves?: Array<{ q?: number; r?: number }> }
  if (parsed.error) {
    throw new Error(parsed.error)
  }

  if (!Array.isArray(parsed.moves)) {
    return []
  }

  return parsed.moves
    .map((move) => ({
      q: Number(move.q),
      r: Number(move.r),
    }))
    .filter((move) => Number.isInteger(move.q) && Number.isInteger(move.r))
}

function applyTurn(state: LiveState, chosenMoves: Array<{ q: number; r: number }>): { state: LiveState; valid: boolean } {
  if (state.winner) {
    return { state: cloneState(state), valid: false }
  }

  const nextState = cloneState(state)
  const seen = new Set<string>()
  const limit = Math.max(1, state.placementsLeft)

  let applied = 0
  for (const move of chosenMoves) {
    if (applied >= limit) {
      break
    }

    const key = toKey(move.q, move.r)
    if (nextState.moves.has(key) || seen.has(key)) {
      return { state: nextState, valid: false }
    }
    seen.add(key)
    nextState.moves.set(key, state.turn)
    nextState.moveHistory.push({
      q: move.q,
      r: move.r,
      mark: state.turn,
    })
    applied += 1

    const winner = findWinner(nextState.moves)
    if (winner) {
      nextState.winner = winner
      return { state: nextState, valid: true }
    }
  }

  if (applied === 0) {
    return { state: nextState, valid: false }
  }

  const nextTurn = deriveTurnState(nextState.moveHistory.length)
  nextState.turn = nextTurn.turn
  nextState.placementsLeft = nextTurn.placementsLeft
  nextState.winner = null
  return { state: nextState, valid: true }
}

function playMatch(
  opening: MoveRecord[],
  xBot: BotKey,
  oBot: BotKey,
  bots: Record<BotKey, BotModule>,
  options: BotSearchOptions,
  maxTurns: number,
): MatchOutcome {
  let state = createStateFromOpening(opening)
  if (state.winner) {
    return {
      winnerBot: state.winner === 'X' ? xBot : oBot,
      winnerMark: state.winner,
      reason: 'win',
      turnsPlayed: 0,
    }
  }

  for (let turnIdx = 0; turnIdx < maxTurns; turnIdx += 1) {
    const activeBot = state.turn === 'X' ? xBot : oBot
    const chosenMoves = chooseMoves(bots[activeBot], state, options)
    const applied = applyTurn(state, chosenMoves)
    if (!applied.valid) {
      return {
        winnerBot: activeBot === xBot ? oBot : xBot,
        winnerMark: activeBot === xBot ? 'O' : 'X',
        reason: 'invalid',
        turnsPlayed: turnIdx,
      }
    }

    state = applied.state
    if (state.winner) {
      return {
        winnerBot: state.winner === 'X' ? xBot : oBot,
        winnerMark: state.winner,
        reason: 'win',
        turnsPlayed: turnIdx + 1,
      }
    }
  }

  return {
    winnerBot: null,
    winnerMark: null,
    reason: 'no-result',
    turnsPlayed: maxTurns,
  }
}

function loadDatasetOpenings(datasetPath: string, openingMoves: number): Array<{ gameId: string; opening: MoveRecord[] }> {
  const lines = readFileSync(datasetPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const openings: Array<{ gameId: string; opening: MoveRecord[] }> = []

  for (const line of lines) {
    const parsed = JSON.parse(line) as DatasetGame
    if (!Array.isArray(parsed.moves) || parsed.moves.length < openingMoves) {
      continue
    }

    const opening: MoveRecord[] = []
    for (let idx = 0; idx < openingMoves; idx += 1) {
      const move = parsed.moves[idx]
      const { turn } = deriveTurnState(opening.length)
      opening.push({
        q: move.x,
        r: move.y,
        mark: turn,
      })
    }

    openings.push({ gameId: parsed.gameId, opening })
  }

  return openings
}

function summarizeBucket(bucket: ScoreBucket): string {
  return `${bucket.wins}-${bucket.losses}-${bucket.noResults}`
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  assertSafeRef(options.baselineRef)
  assertSafeRef(options.candidateRef)

  const rng = createRng(options.seed)
  const openings = loadDatasetOpenings(options.datasetPath, options.openingMoves)
  if (openings.length === 0) {
    throw new Error(`No openings found in ${options.datasetPath}`)
  }

  shuffleInPlace(openings, rng)
  const selectedOpenings = openings.slice(0, Math.min(options.openingCount, openings.length))
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'hex-ttt-arena-'))

  try {
    const baselineCheckout = path.join(tempRoot, 'baseline-checkout')
    const candidateCheckout = path.join(tempRoot, 'candidate-checkout')
    const baselinePkg = path.join(tempRoot, 'baseline-pkg')
    const candidatePkg = path.join(tempRoot, 'candidate-pkg')

    console.log(`Building baseline ${options.baselineRef}...`)
    exportRefToDir(options.baselineRef, baselineCheckout)
    buildNodeBot(baselineCheckout, baselinePkg)

    console.log(`Building candidate ${options.candidateRef}...`)
    exportRefToDir(options.candidateRef, candidateCheckout)
    buildNodeBot(candidateCheckout, candidatePkg)

    const bots: Record<BotKey, BotModule> = {
      baseline: loadBotModule(baselinePkg),
      candidate: loadBotModule(candidatePkg),
    }
    const searchOptions = SEARCH_PROFILES[options.profile]

    const overall: ScoreBucket = { wins: 0, losses: 0, noResults: 0 }
    const asX: ScoreBucket = { wins: 0, losses: 0, noResults: 0 }
    const asO: ScoreBucket = { wins: 0, losses: 0, noResults: 0 }
    const reasons = new Map<string, number>()

    console.log(
      `Arena: candidate=${options.candidateRef} vs baseline=${options.baselineRef} | profile=${options.profile} | openings=${selectedOpenings.length} | openingMoves=${options.openingMoves} | maxTurns=${options.maxTurns}`,
    )

    for (const [openingIdx, entry] of selectedOpenings.entries()) {
      const candidateAsX = playMatch(entry.opening, 'candidate', 'baseline', bots, searchOptions, options.maxTurns)
      const candidateAsO = playMatch(entry.opening, 'baseline', 'candidate', bots, searchOptions, options.maxTurns)

      const matches: Array<{ role: 'X' | 'O'; outcome: MatchOutcome; bucket: ScoreBucket }> = [
        { role: 'X', outcome: candidateAsX, bucket: asX },
        { role: 'O', outcome: candidateAsO, bucket: asO },
      ]

      for (const match of matches) {
        const reasonKey = `${match.role}:${match.outcome.reason}`
        reasons.set(reasonKey, (reasons.get(reasonKey) ?? 0) + 1)

        if (match.outcome.winnerBot === 'candidate') {
          overall.wins += 1
          match.bucket.wins += 1
        } else if (match.outcome.winnerBot === 'baseline') {
          overall.losses += 1
          match.bucket.losses += 1
        } else {
          overall.noResults += 1
          match.bucket.noResults += 1
        }
      }

      console.log(
        [
          `Opening ${openingIdx + 1}/${selectedOpenings.length}`,
          entry.gameId,
          `candidate-as-X=${candidateAsX.winnerBot ?? 'none'}:${candidateAsX.reason}`,
          `candidate-as-O=${candidateAsO.winnerBot ?? 'none'}:${candidateAsO.reason}`,
        ].join(' | '),
      )
    }

    const summary = {
      baselineRef: options.baselineRef,
      candidateRef: options.candidateRef,
      profile: options.profile,
      openings: selectedOpenings.length,
      openingMoves: options.openingMoves,
      maxTurns: options.maxTurns,
      seed: options.seed,
      candidateOverall: summaryObject(overall),
      candidateAsX: summaryObject(asX),
      candidateAsO: summaryObject(asO),
      reasonCounts: Object.fromEntries([...reasons.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      sampledGameIds: selectedOpenings.map((entry) => entry.gameId),
    }

    console.log('\nSummary')
    console.log(`Candidate overall (W-L-NR): ${summarizeBucket(overall)}`)
    console.log(`Candidate as X (W-L-NR): ${summarizeBucket(asX)}`)
    console.log(`Candidate as O (W-L-NR): ${summarizeBucket(asO)}`)
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function summaryObject(bucket: ScoreBucket): ScoreBucket & { total: number; score: number } {
  const total = bucket.wins + bucket.losses + bucket.noResults
  return {
    ...bucket,
    total,
    score: total === 0 ? 0 : (bucket.wins + bucket.noResults * 0.5) / total,
  }
}

await main()
