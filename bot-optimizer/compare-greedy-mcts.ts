import { performance } from 'node:perf_hooks'
import {
  DEFAULT_BOT_SEARCH_OPTIONS,
  DEFAULT_BOT_TUNING,
  chooseBotTurnDetailed,
  chooseGreedyTurn,
  type Axial,
  type BotSearchOptions,
  type BotTuning,
  type LiveLikeState,
  type Player,
} from '../src/bot/engine.ts'

type Mode = 'greedy' | 'mcts'

type SideConfig = {
  mode: Mode
  tuning: BotTuning
  options: BotSearchOptions
}

type GameResult = {
  winner: Player | 'draw'
  placements: number
  xDecisionMs: number
  oDecisionMs: number
}

const WIN_LENGTH = 6
const WIN_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, -1],
]

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function countDirectional(board: Map<string, Player>, q: number, r: number, dq: number, dr: number, player: Player): number {
  let count = 0
  let cq = q + dq
  let cr = r + dr
  while (board.get(toKey(cq, cr)) === player) {
    count += 1
    cq += dq
    cr += dr
  }
  return count
}

function isWinningPlacement(board: Map<string, Player>, q: number, r: number, player: Player): boolean {
  for (const [dq, dr] of WIN_DIRECTIONS) {
    const forward = countDirectional(board, q, r, dq, dr, player)
    const backward = countDirectional(board, q, r, -dq, -dr, player)
    if (1 + forward + backward >= WIN_LENGTH) {
      return true
    }
  }
  return false
}

function createInitialState(): LiveLikeState {
  return {
    moves: new Map<string, Player>(),
    moveHistory: [],
    turn: 'X',
    placementsLeft: 1,
  }
}

function chooseMoves(state: LiveLikeState, config: SideConfig): Axial[] {
  if (config.mode === 'greedy') {
    return chooseGreedyTurn(state, config.tuning)
  }
  return chooseBotTurnDetailed(state, config.tuning, config.options).moves
}

function playSingleGame(xConfig: SideConfig, oConfig: SideConfig, maxPlacements: number): GameResult {
  const state = createInitialState()
  let placements = 0
  let xDecisionMs = 0
  let oDecisionMs = 0

  while (placements < maxPlacements) {
    const currentConfig = state.turn === 'X' ? xConfig : oConfig
    const start = performance.now()
    const planned = chooseMoves(state, currentConfig)
    const elapsed = performance.now() - start

    if (state.turn === 'X') xDecisionMs += elapsed
    else oDecisionMs += elapsed

    if (planned.length === 0) {
      return { winner: 'draw', placements, xDecisionMs, oDecisionMs }
    }

    let legalPlayed = 0
    for (let i = 0; i < planned.length && legalPlayed < state.placementsLeft; i += 1) {
      const move = planned[i]
      const key = toKey(move.q, move.r)
      if (state.moves.has(key)) continue

      state.moves.set(key, state.turn)
      state.moveHistory.push({ q: move.q, r: move.r, mark: state.turn })
      placements += 1
      legalPlayed += 1

      if (isWinningPlacement(state.moves, move.q, move.r, state.turn)) {
        return { winner: state.turn, placements, xDecisionMs, oDecisionMs }
      }
    }

    if (legalPlayed === 0) {
      return { winner: 'draw', placements, xDecisionMs, oDecisionMs }
    }

    state.turn = state.turn === 'X' ? 'O' : 'X'
    state.placementsLeft = 2
  }

  return { winner: 'draw', placements, xDecisionMs, oDecisionMs }
}

function parseArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name)
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback
  const value = Number(process.argv[idx + 1])
  return Number.isFinite(value) ? value : fallback
}

function main(): void {
  const games = Math.max(2, Math.floor(parseArg('--games', 20)))
  const thinkMs = Math.max(0, Math.floor(parseArg('--think-ms', 1000)))
  const maxPlacements = Math.max(40, Math.floor(parseArg('--max-placements', 180)))

  const mctsOptions: BotSearchOptions = {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    budget: { maxTimeMs: thinkMs, maxNodes: 1_000_000 },
  }

  const greedyConfig: SideConfig = {
    mode: 'greedy',
    tuning: DEFAULT_BOT_TUNING,
    options: { ...DEFAULT_BOT_SEARCH_OPTIONS, budget: { maxTimeMs: 0, maxNodes: 0 } },
  }
  const mctsConfig: SideConfig = {
    mode: 'mcts',
    tuning: DEFAULT_BOT_TUNING,
    options: mctsOptions,
  }

  let mctsWins = 0
  let greedyWins = 0
  let draws = 0
  let mctsDecisionMs = 0
  let greedyDecisionMs = 0

  for (let i = 0; i < games; i += 1) {
    const mctsIsX = i % 2 === 0
    const result = mctsIsX
      ? playSingleGame(mctsConfig, greedyConfig, maxPlacements)
      : playSingleGame(greedyConfig, mctsConfig, maxPlacements)

    if (mctsIsX) {
      mctsDecisionMs += result.xDecisionMs
      greedyDecisionMs += result.oDecisionMs
    } else {
      mctsDecisionMs += result.oDecisionMs
      greedyDecisionMs += result.xDecisionMs
    }

    if (result.winner === 'draw') {
      draws += 1
    } else if ((result.winner === 'X' && mctsIsX) || (result.winner === 'O' && !mctsIsX)) {
      mctsWins += 1
    } else {
      greedyWins += 1
    }
  }

  console.log(`Games: ${games} | think-ms: ${thinkMs} | max-placements: ${maxPlacements}`)
  console.log(`MCTS wins: ${mctsWins}`)
  console.log(`Greedy wins: ${greedyWins}`)
  console.log(`Draws: ${draws}`)
  console.log(`Avg decision ms (MCTS): ${(mctsDecisionMs / games).toFixed(2)}`)
  console.log(`Avg decision ms (Greedy): ${(greedyDecisionMs / games).toFixed(2)}`)
}

main()

