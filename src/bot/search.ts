import { evaluateBoardState } from './evaluation'
import type {
  Axial,
  BotSearchOptions,
  BotSearchStats,
  BotTuning,
  BotTurnDecision,
  EvaluationResult,
  LiveLikeState,
  Player,
} from './types'
import { DEFAULT_BOT_SEARCH_OPTIONS, DEFAULT_BOT_TUNING, WIN_DIRECTIONS, WIN_LENGTH } from './types'

let activeBoardEvalCounter: { count: number } | null = null

function beginBoardEvalCount(): { count: number } {
  const counter = { count: 0 }
  activeBoardEvalCounter = counter
  return counter
}

function evaluateBoardStateTracked(moves: Map<string, Player>, tuning: BotTuning): EvaluationResult {
  activeBoardEvalCounter = activeBoardEvalCounter ?? { count: 0 }
  activeBoardEvalCounter.count += 1
  return evaluateBoardState(moves, tuning)
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function fromKey(key: string): Axial {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
}

function appendMove(state: LiveLikeState, q: number, r: number, mark: Player): LiveLikeState {
  const nextMoves = new Map(state.moves)
  nextMoves.set(toKey(q, r), mark)
  return {
    ...state,
    moves: nextMoves,
    moveHistory: [...state.moveHistory, { q, r, mark }],
  }
}

function turnStateFromMoveCount(totalMoves: number): { turn: Player; placementsLeft: number } {
  if (totalMoves === 0) {
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

function candidateCells(moves: Map<string, Player>, radius: number): Axial[] {
  if (moves.size === 0) {
    return [{ q: 0, r: 0 }]
  }

  const occupied = new Set(moves.keys())
  const candidates = new Set<string>()

  for (const key of occupied) {
    const { q, r } = fromKey(key)
    for (let dq = -radius; dq <= radius; dq += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        const ds = -dq - dr
        const distance = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds))
        if (distance > radius) continue
        const cellKey = toKey(q + dq, r + dr)
        if (!occupied.has(cellKey)) {
          candidates.add(cellKey)
        }
      }
    }
  }

  return [...candidates].map(fromKey)
}

function sortAxials(cells: Axial[]): Axial[] {
  return cells.sort((a, b) => (a.q !== b.q ? a.q - b.q : a.r - b.r))
}

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const ADJACENT_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
]

function localConnectivityScore(moves: Map<string, Player>, player: Player, cell: Axial): number {
  let friendly = 0
  let occupied = 0
  const opponent: Player = player === 'X' ? 'O' : 'X'

  for (const [dq, dr] of ADJACENT_DIRECTIONS) {
    const mark = moves.get(toKey(cell.q + dq, cell.r + dr))
    if (!mark) continue
    occupied += 1
    if (mark === player) friendly += 1
    if (mark === opponent) occupied += 0.5
  }

  return friendly * 3 + occupied
}

function trimCandidatesForRanking(
  candidates: Axial[],
  moves: Map<string, Player>,
  player: Player,
  maxCount: number,
): Axial[] {
  if (candidates.length <= maxCount) return candidates
  const scored = candidates.map((cell) => ({
    cell,
    score: localConnectivityScore(moves, player, cell),
  }))
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.cell.q !== b.cell.q) return a.cell.q - b.cell.q
    return a.cell.r - b.cell.r
  })
  return scored.slice(0, maxCount).map((entry) => entry.cell)
}

function pickDeterministicSample(cells: Axial[], count: number, seed: string): Axial[] {
  if (count <= 0 || cells.length === 0) return []
  const scored = cells.map((cell) => ({
    cell,
    score: hashString(`${seed}|${toKey(cell.q, cell.r)}`),
  }))
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.cell.q !== b.cell.q) return a.cell.q - b.cell.q
    return a.cell.r - b.cell.r
  })
  return scored.slice(0, count).map((entry) => entry.cell)
}

function addExplorationCandidates(
  primary: Axial[],
  fallbackPool: Axial[],
  moves: Map<string, Player>,
  player: Player,
  sampleCount: number,
  seed: string,
): Axial[] {
  if (sampleCount <= 0) return primary
  const present = new Set(primary.map((cell) => toKey(cell.q, cell.r)))
  const unexplored = fallbackPool.filter((cell) => !present.has(toKey(cell.q, cell.r)))
  if (unexplored.length === 0) return primary

  // Prefer sparser cells for deliberate long-shot exploration.
  const sparse = unexplored.filter((cell) => localConnectivityScore(moves, player, cell) <= 2)
  const source = sparse.length > 0 ? sparse : unexplored
  const sampled = pickDeterministicSample(source, sampleCount, seed)
  return uniqueAxials([...primary, ...sampled])
}

function uniqueAxials(cells: Axial[]): Axial[] {
  const seen = new Set<string>()
  const unique: Axial[] = []
  for (const cell of cells) {
    const key = toKey(cell.q, cell.r)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(cell)
  }
  return unique
}

function collectOneTurnFinishCells(moves: Map<string, Player>, player: Player): Set<string> {
  const finishCells = new Set<string>()
  if (moves.size === 0) return finishCells

  const occupied = [...moves.keys()].map(fromKey)
  let minQ = occupied[0].q
  let maxQ = occupied[0].q
  let minR = occupied[0].r
  let maxR = occupied[0].r

  for (const cell of occupied) {
    if (cell.q < minQ) minQ = cell.q
    if (cell.q > maxQ) maxQ = cell.q
    if (cell.r < minR) minR = cell.r
    if (cell.r > maxR) maxR = cell.r
  }

  const margin = WIN_LENGTH
  const qStart = minQ - margin
  const qEnd = maxQ + margin
  const rStart = minR - margin
  const rEnd = maxR + margin
  const opponent: Player = player === 'X' ? 'O' : 'X'

  for (let q = qStart; q <= qEnd; q += 1) {
    for (let r = rStart; r <= rEnd; r += 1) {
      for (const [dq, dr] of WIN_DIRECTIONS) {
        let own = 0
        let opp = 0
        const empties: string[] = []

        for (let i = 0; i < WIN_LENGTH; i += 1) {
          const key = toKey(q + dq * i, r + dr * i)
          const mark = moves.get(key)
          if (mark === player) own += 1
          if (mark === opponent) {
            opp += 1
            break
          }
          if (!mark) empties.push(key)
        }

        if (opp > 0) continue
        if (own >= 4 && empties.length <= 2) {
          for (const key of empties) finishCells.add(key)
        }
      }
    }
  }

  return finishCells
}

function collectThreatConnectedCandidates(moves: Map<string, Player>, player: Player): Axial[] {
  if (moves.size === 0) {
    return [{ q: 0, r: 0 }]
  }

  const candidates = new Set<string>()
  const occupied = [...moves.keys()].map(fromKey)
  let minQ = occupied[0].q
  let maxQ = occupied[0].q
  let minR = occupied[0].r
  let maxR = occupied[0].r

  for (const cell of occupied) {
    if (cell.q < minQ) minQ = cell.q
    if (cell.q > maxQ) maxQ = cell.q
    if (cell.r < minR) minR = cell.r
    if (cell.r > maxR) maxR = cell.r
  }

  const margin = WIN_LENGTH
  const qStart = minQ - margin
  const qEnd = maxQ + margin
  const rStart = minR - margin
  const rEnd = maxR + margin
  const opponent: Player = player === 'X' ? 'O' : 'X'

  for (let q = qStart; q <= qEnd; q += 1) {
    for (let r = rStart; r <= rEnd; r += 1) {
      for (const [dq, dr] of WIN_DIRECTIONS) {
        let own = 0
        let opp = 0
        const empties: string[] = []

        for (let i = 0; i < WIN_LENGTH; i += 1) {
          const key = toKey(q + dq * i, r + dr * i)
          const mark = moves.get(key)
          if (mark === player) own += 1
          if (mark === opponent) {
            opp += 1
            break
          }
          if (!mark) empties.push(key)
        }

        if (own <= 0 || opp > 0) continue
        for (const key of empties) candidates.add(key)
      }
    }
  }

  return sortAxials([...candidates].map(fromKey))
}

function collectLegalCandidates(state: LiveLikeState, player: Player, tuning: BotTuning): Axial[] {
  const opponent: Player = player === 'X' ? 'O' : 'X'
  const ownFinishes = collectOneTurnFinishCells(state.moves, player)
  if (ownFinishes.size > 0) {
    return sortAxials([...ownFinishes].map(fromKey))
  }

  const forcedBlocks = collectOneTurnFinishCells(state.moves, opponent)
  if (forcedBlocks.size > 0) {
    return sortAxials([...forcedBlocks].map(fromKey))
  }

  const connected = collectThreatConnectedCandidates(state.moves, player)
  const legal = uniqueAxials([
    ...connected,
  ])

  if (legal.length > 0) {
    return sortAxials(legal)
  }

  return sortAxials(candidateCells(state.moves, tuning.candidateRadius))
}

type RankedPlacement = {
  option: Axial
  simulated: LiveLikeState
  immediateWin: boolean
  objective: number
  ownScore: number
}

function rankPlacements(
  working: LiveLikeState,
  player: Player,
  tuning: BotTuning,
  moveOptions: Axial[],
  rankOptions?: { ignoreDangerFlag?: boolean },
): RankedPlacement[] {
  const ranked = moveOptions.map((option) => {
    const simulated = appendMove(working, option.q, option.r, player)
    const immediateWin = isWinningPlacement(simulated.moves, option.q, option.r, player)
    const evalResult = evaluateBoardStateTracked(simulated.moves, tuning)
    const objective = immediateWin
      ? Number.POSITIVE_INFINITY
      : objectiveForPlayer(evalResult, player, tuning, rankOptions)
    const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore
    return { option, simulated, immediateWin, objective, ownScore }
  })

  ranked.sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })

  return ranked
}

function collectWinningTurnLines(state: LiveLikeState, player: Player, tuning: BotTuning): Axial[][] {
  if (state.placementsLeft <= 0) return []

  const firstOptions = collectLegalCandidates(state, player, tuning)
  if (firstOptions.length === 0) return []

  const winners: Axial[][] = []
  const seen = new Set<string>()

  for (const first of firstOptions) {
    const afterFirst = appendMove(state, first.q, first.r, player)
    if (isWinningPlacement(afterFirst.moves, first.q, first.r, player)) {
      const key = toKey(first.q, first.r)
      if (!seen.has(key)) {
        seen.add(key)
        winners.push([first])
      }
      continue
    }

    if (state.placementsLeft < 2) continue

    const secondOptions = collectLegalCandidates(afterFirst, player, tuning)
    for (const second of secondOptions) {
      const afterSecond = appendMove(afterFirst, second.q, second.r, player)
      if (!isWinningPlacement(afterSecond.moves, second.q, second.r, player)) continue
      const key = `${toKey(first.q, first.r)}|${toKey(second.q, second.r)}`
      if (seen.has(key)) continue
      seen.add(key)
      winners.push([first, second])
    }
  }

  return winners
}

function enumerateTurnCandidates(state: LiveLikeState, tuning: BotTuning, maxCandidates: number): Axial[][] {
  const player = state.turn
  const placements = state.placementsLeft
  if (placements <= 0) return []

  const winningLines = collectWinningTurnLines(state, player, tuning)
  if (winningLines.length > 0) {
    return winningLines
  }

  const baseEval = evaluateBoardStateTracked(state.moves, tuning)
  const baselineOppWins = opponentOneTurnWins(baseEval, player)
  const firstOptions = collectLegalCandidates(state, player, tuning)
  const ownFinishNow = collectOneTurnFinishCells(state.moves, player)
  const tacticalMode = ownFinishNow.size > 0 || baselineOppWins > 0
  const nonTacticalFirstCap = 30
  const nonTacticalSecondCap = 20
  const explorationFirstSample = 3
  const explorationSecondSample = 2
  const trimmedFirstOptions = tacticalMode
    ? firstOptions
    : addExplorationCandidates(
        trimCandidatesForRanking(firstOptions, state.moves, player, nonTacticalFirstCap),
        candidateCells(state.moves, tuning.candidateRadius),
        state.moves,
        player,
        explorationFirstSample,
        `first|${state.moveHistory.length}|${player}`,
      )
  const firstRanked = rankPlacements(state, player, tuning, trimmedFirstOptions, { ignoreDangerFlag: placements >= 2 })
  if (firstRanked.length === 0) return []

  const baselineOppFinish = collectOneTurnFinishCells(state.moves, player === 'X' ? 'O' : 'X')
  const capped = Math.max(1, Math.floor(maxCandidates))

  const maybeApplyDefensivePruning = (
    lines: Array<{ line: Axial[]; objective: number; ownScore: number; immediateWin: boolean; oppOneTurnWins: number }>,
  ) => {
    if (baselineOppWins <= 0) return lines

    const fullyBlocked = lines.filter((entry) => entry.oppOneTurnWins === 0)
    if (fullyBlocked.length > 0) return fullyBlocked

    const minOppWins = lines.reduce((min, entry) => Math.min(min, entry.oppOneTurnWins), Number.POSITIVE_INFINITY)
    return lines.filter((entry) => entry.oppOneTurnWins === minOppWins)
  }

  if (placements === 1) {
    const forcedBlocks = baselineOppFinish
    const singleMovePool =
      forcedBlocks.size > 0
        ? firstRanked.filter((entry) => forcedBlocks.has(toKey(entry.option.q, entry.option.r)))
        : firstRanked
    const lines = singleMovePool.slice(0, capped).map((entry) => {
      const evalResult = evaluateBoardStateTracked(entry.simulated.moves, tuning)
      return {
        line: [entry.option],
        objective: objectiveForPlayer(evalResult, player, tuning),
        ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
        immediateWin: entry.immediateWin,
        oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      }
    })
    const pruned = maybeApplyDefensivePruning(lines)
    pruned.sort((a, b) => {
      if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
      if (a.objective !== b.objective) return b.objective - a.objective
      return b.ownScore - a.ownScore
    })
    return pruned.map((entry) => entry.line)
  }

  const firstCandidates = firstRanked

  const lines: Array<{ line: Axial[]; objective: number; ownScore: number; immediateWin: boolean; oppOneTurnWins: number }> = []

  for (const first of firstCandidates) {
    const secondOptions = collectLegalCandidates(first.simulated, player, tuning)
    const trimmedSecondOptions = tacticalMode
      ? secondOptions
      : addExplorationCandidates(
          trimCandidatesForRanking(secondOptions, first.simulated.moves, player, nonTacticalSecondCap),
          candidateCells(first.simulated.moves, tuning.candidateRadius),
          first.simulated.moves,
          player,
          explorationSecondSample,
          `second|${state.moveHistory.length}|${player}|${toKey(first.option.q, first.option.r)}`,
        )
    const secondRanked = rankPlacements(first.simulated, player, tuning, trimmedSecondOptions)
    if (secondRanked.length === 0) {
      const evalResult = evaluateBoardStateTracked(first.simulated.moves, tuning)
      lines.push({
        line: [first.option],
        objective: objectiveForPlayer(evalResult, player, tuning),
        ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
        immediateWin: first.immediateWin,
        oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      })
      continue
    }

    for (const second of secondRanked) {
      const evalResult = evaluateBoardStateTracked(second.simulated.moves, tuning)
      lines.push({
        line: [first.option, second.option],
        objective: objectiveForPlayer(evalResult, player, tuning),
        ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
        immediateWin: second.immediateWin,
        oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      })
    }
  }

  if (lines.length === 0) {
    return [[firstCandidates[0].option]]
  }

  const pruned = maybeApplyDefensivePruning(lines)
  pruned.sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })

  const unique = new Set<string>()
  const picks: Axial[][] = []
  for (const candidate of pruned) {
    const key = candidate.line.map((cell) => toKey(cell.q, cell.r)).join('|')
    if (unique.has(key)) continue
    unique.add(key)
    picks.push(candidate.line)
    if (picks.length >= capped) break
  }

  return picks
}

function objectiveForPlayer(
  result: EvaluationResult,
  player: Player,
  tuning: BotTuning,
  options?: { ignoreDangerFlag?: boolean },
): number {
  const own = player === 'X' ? result.xScore : result.oScore
  const opp = player === 'X' ? result.oScore : result.xScore
  void options
  return own - tuning.defenseWeight * opp
}

function opponentOneTurnWins(result: EvaluationResult, player: Player): number {
  return player === 'X' ? result.oOneTurnWins : result.xOneTurnWins
}

function countDirectional(
  board: Map<string, Player>,
  q: number,
  r: number,
  dq: number,
  dr: number,
  player: Player,
): number {
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

function findImmediateWinningMove(state: LiveLikeState, player: Player, radius: number): Axial | null {
  const options = candidateCells(state.moves, radius)
  for (const option of options) {
    const simulated = appendMove(state, option.q, option.r, player)
    if (isWinningPlacement(simulated.moves, option.q, option.r, player)) {
      return option
    }
  }
  return null
}

export function chooseGreedyTurn(state: LiveLikeState, tuning: BotTuning = DEFAULT_BOT_TUNING): Axial[] {
  const player = state.turn
  const placements = state.placementsLeft
  if (placements <= 0) return []

  // Hard tactical rule: if a winning move exists right now, take it immediately.
  const immediateWin = findImmediateWinningMove(state, player, tuning.candidateRadius)
  if (immediateWin) {
    return [immediateWin]
  }

  const candidateCount = placements >= 2 ? 48 : 24
  const candidateLines = enumerateTurnCandidates(state, tuning, candidateCount)
  if (candidateLines.length === 0) return []

  let bestLine: Axial[] = candidateLines[0]
  let bestObjective = Number.NEGATIVE_INFINITY
  let bestOwn = Number.NEGATIVE_INFINITY

  for (const line of candidateLines) {
    const applied = applyTurnLine(state, line)
    if (applied.winner === player) {
      return line
    }
    const evalResult = evaluateBoardStateTracked(applied.state.moves, tuning)
    const objective = objectiveForPlayer(evalResult, player, tuning)
    const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore

    if (objective > bestObjective || (objective === bestObjective && ownScore > bestOwn)) {
      bestLine = line
      bestObjective = objective
      bestOwn = ownScore
    }
  }

  return bestLine
}

function findWinner(moves: Map<string, Player>): Player | null {
  for (const [key, player] of moves.entries()) {
    const { q, r } = fromKey(key)
    if (isWinningPlacement(moves, q, r, player)) {
      return player
    }
  }
  return null
}

type AppliedTurn = {
  state: LiveLikeState
  winner: Player | null
}

function applyTurnLine(state: LiveLikeState, line: Axial[]): AppliedTurn {
  const nextMoves = new Map(state.moves)
  const nextHistory = [...state.moveHistory]
  let turn = state.turn
  let placementsLeft = state.placementsLeft
  let winner: Player | null = null

  for (const move of line) {
    if (placementsLeft <= 0 || winner) break
    const key = toKey(move.q, move.r)
    if (nextMoves.has(key)) continue

    nextMoves.set(key, turn)
    nextHistory.push({ q: move.q, r: move.r, mark: turn })

    if (isWinningPlacement(nextMoves, move.q, move.r, turn)) {
      winner = turn
      placementsLeft = 0
      break
    }

    placementsLeft -= 1
    if (placementsLeft === 0) {
      const nextTurn = turnStateFromMoveCount(nextMoves.size)
      turn = nextTurn.turn
      placementsLeft = nextTurn.placementsLeft
    }
  }

  return {
    state: {
      moves: nextMoves,
      moveHistory: nextHistory,
      turn,
      placementsLeft,
    },
    winner,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function evaluateNodeForRoot(
  state: LiveLikeState,
  winner: Player | null,
  rootPlayer: Player,
  tuning: BotTuning,
): number {
  if (winner) return winner === rootPlayer ? 1 : -1
  const result = evaluateBoardStateTracked(state.moves, tuning)
  const objective = rootPlayer === 'X' ? result.objectiveForX : result.objectiveForO
  return Math.tanh(objective / 12000)
}

type SearchNode = {
  state: LiveLikeState
  winner: Player | null
  parent: SearchNode | null
  actionFromParent: Axial[] | null
  children: SearchNode[]
  untriedActions: Axial[][]
  visits: number
  totalValue: number
}

export type BotSearchProgress = {
  elapsedMs: number
  nodesExpanded: number
  playouts: number
  boardEvaluations: number
  maxDepthTurns: number
}

type SearchProgressOptions = {
  onProgress?: (progress: BotSearchProgress) => void
  yieldEveryMs?: number
}

function selectUctChild(node: SearchNode, explorationC: number): SearchNode {
  const logParent = Math.log(Math.max(1, node.visits))
  let best = node.children[0]
  let bestScore = Number.NEGATIVE_INFINITY

  for (const child of node.children) {
    if (child.visits === 0) {
      return child
    }
    const exploit = child.totalValue / child.visits
    const explore = explorationC * Math.sqrt(logParent / child.visits)
    const score = exploit + explore
    if (score > bestScore) {
      bestScore = score
      best = child
    }
  }

  return best
}

function rootActionFor(node: SearchNode): Axial[] | null {
  let current: SearchNode | null = node
  while (current && current.parent && current.parent.parent) {
    current = current.parent
  }
  if (!current || !current.parent) return null
  return current.actionFromParent
}

function rolloutValue(node: SearchNode, rootPlayer: Player, tuning: BotTuning, options: BotSearchOptions): number {
  if (node.winner) {
    return node.winner === rootPlayer ? 1 : -1
  }

  let simState: LiveLikeState = {
    moves: new Map(node.state.moves),
    moveHistory: [...node.state.moveHistory],
    turn: node.state.turn,
    placementsLeft: node.state.placementsLeft,
  }
  let simWinner: Player | null = null

  const rolloutTuning: BotTuning = {
    ...tuning,
    candidateRadius: clamp(options.simulationRadius, 1, 7),
    topKFirstMoves: Math.max(1, Math.floor(options.simulationTopKFirstMoves)),
  }

  for (let depth = 0; depth < options.maxSimulationTurns; depth += 1) {
    const plan = chooseGreedyTurn(simState, rolloutTuning)
    if (plan.length === 0) break
    const applied = applyTurnLine(simState, plan)
    simState = applied.state
    simWinner = applied.winner
    if (simWinner) break
  }

  return evaluateNodeForRoot(simState, simWinner, rootPlayer, tuning)
}

export function chooseBotTurnDetailed(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotTurnDecision {
  const start = nowMs()
  const options: BotSearchOptions = {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    ...partialOptions,
    budget: {
      ...DEFAULT_BOT_SEARCH_OPTIONS.budget,
      ...partialOptions.budget,
    },
  }
  const evalCounter = beginBoardEvalCount()

  if (state.placementsLeft <= 0) {
    return {
      moves: [],
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }
  if (options.budget.maxTimeMs <= 0 || options.budget.maxNodes <= 0) {
    return {
      moves: chooseGreedyTurn(state, tuning),
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'budget_zero',
      },
    }
  }

  const existingWinner = findWinner(state.moves)
  if (existingWinner) {
    return {
      moves: [],
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }

  const rootPlayer = state.turn
  const rootCandidates = enumerateTurnCandidates(state, tuning, Math.max(1, Math.floor(options.turnCandidateCount)))
  const root: SearchNode = {
    state,
    winner: null,
    parent: null,
    actionFromParent: null,
    children: [],
    untriedActions: rootCandidates,
    visits: 0,
    totalValue: 0,
  }

  if (root.untriedActions.length === 0) {
    return {
      moves: chooseGreedyTurn(state, tuning),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 1,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: rootCandidates.length,
        stopReason: 'no_candidates',
      },
    }
  }

  let nodesExpanded = 1
  let playouts = 0
  let maxDepthTurns = 0
  let stopReason: BotSearchStats['stopReason'] = 'time'

  // Early stop before MCTS loop if any root action is an immediate winning turn-line.
  for (const line of rootCandidates) {
    const applied = applyTurnLine(state, line)
    if (applied.winner === rootPlayer) {
      return {
        moves: line,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded,
          playouts,
          boardEvaluations: evalCounter.count,
          maxDepthTurns,
          rootCandidates: rootCandidates.length,
          stopReason: 'early_win',
        },
      }
    }
  }

  while (nodesExpanded < options.budget.maxNodes && nowMs() - start < options.budget.maxTimeMs) {
    let depthTurns = 0
    let node = root

    while (node.untriedActions.length === 0 && node.children.length > 0 && !node.winner) {
      node = selectUctChild(node, options.explorationC)
      depthTurns += 1
    }

    if (node.untriedActions.length > 0 && !node.winner) {
      const action = node.untriedActions.pop() as Axial[]
      const applied = applyTurnLine(node.state, action)
      const child: SearchNode = {
        state: applied.state,
        winner: applied.winner,
        parent: node,
        actionFromParent: action,
        children: [],
        untriedActions: applied.winner
          ? []
          : enumerateTurnCandidates(applied.state, tuning, Math.max(1, Math.floor(options.turnCandidateCount))),
        visits: 0,
        totalValue: 0,
      }
      node.children.push(child)
      node = child
      nodesExpanded += 1
      depthTurns += 1
    }

    if (depthTurns > maxDepthTurns) {
      maxDepthTurns = depthTurns
    }

    const value = rolloutValue(node, rootPlayer, tuning, options)
    playouts += 1
    let current: SearchNode | null = node
    while (current) {
      current.visits += 1
      current.totalValue += value
      current = current.parent
    }

    // Early stop as soon as we discover a concrete winning continuation for the root player.
    if (node.winner === rootPlayer) {
      const rootAction = rootActionFor(node)
      if (rootAction) {
        return {
          moves: rootAction,
          stats: {
            mode: 'mcts',
            elapsedMs: nowMs() - start,
            nodesExpanded,
            playouts,
            boardEvaluations: evalCounter.count,
            maxDepthTurns,
            rootCandidates: rootCandidates.length,
            stopReason: 'early_win',
          },
        }
      }
    }
  }

  if (nodesExpanded >= options.budget.maxNodes) {
    stopReason = 'nodes'
  } else if (nowMs() - start >= options.budget.maxTimeMs) {
    stopReason = 'time'
  }

  if (root.children.length === 0) {
    return {
      moves: chooseGreedyTurn(state, tuning),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded,
        playouts,
        boardEvaluations: evalCounter.count,
        maxDepthTurns,
        rootCandidates: rootCandidates.length,
        stopReason: 'fallback',
      },
    }
  }

  root.children.sort((a, b) => {
    if (a.visits !== b.visits) return b.visits - a.visits
    const aMean = a.visits > 0 ? a.totalValue / a.visits : Number.NEGATIVE_INFINITY
    const bMean = b.visits > 0 ? b.totalValue / b.visits : Number.NEGATIVE_INFINITY
    return bMean - aMean
  })

  return {
    moves: root.children[0].actionFromParent ?? chooseGreedyTurn(state, tuning),
    stats: {
      mode: 'mcts',
      elapsedMs: nowMs() - start,
      nodesExpanded,
      playouts,
      boardEvaluations: evalCounter.count,
      maxDepthTurns,
      rootCandidates: rootCandidates.length,
      stopReason,
    },
  }
}

function sleep0(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export async function chooseBotTurnDetailedAsync(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
  progressOptions: SearchProgressOptions = {},
): Promise<BotTurnDecision> {
  const start = nowMs()
  const options: BotSearchOptions = {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    ...partialOptions,
    budget: {
      ...DEFAULT_BOT_SEARCH_OPTIONS.budget,
      ...partialOptions.budget,
    },
  }
  const evalCounter = beginBoardEvalCount()
  const reportProgress = (
    nodesExpanded: number,
    playouts: number,
    maxDepthTurns: number,
  ) => {
    progressOptions.onProgress?.({
      elapsedMs: nowMs() - start,
      nodesExpanded,
      playouts,
      boardEvaluations: evalCounter.count,
      maxDepthTurns,
    })
  }
  const yieldEveryMs = Math.max(8, Math.floor(progressOptions.yieldEveryMs ?? 16))

  if (state.placementsLeft <= 0) {
    reportProgress(0, 0, 0)
    return {
      moves: [],
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }
  if (options.budget.maxTimeMs <= 0 || options.budget.maxNodes <= 0) {
    reportProgress(0, 0, 0)
    return {
      moves: chooseGreedyTurn(state, tuning),
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'budget_zero',
      },
    }
  }

  const existingWinner = findWinner(state.moves)
  if (existingWinner) {
    reportProgress(0, 0, 0)
    return {
      moves: [],
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }

  const rootPlayer = state.turn
  const rootCandidates = enumerateTurnCandidates(state, tuning, Math.max(1, Math.floor(options.turnCandidateCount)))
  const root: SearchNode = {
    state,
    winner: null,
    parent: null,
    actionFromParent: null,
    children: [],
    untriedActions: rootCandidates,
    visits: 0,
    totalValue: 0,
  }

  if (root.untriedActions.length === 0) {
    reportProgress(1, 0, 0)
    return {
      moves: chooseGreedyTurn(state, tuning),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 1,
        playouts: 0,
        boardEvaluations: evalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: rootCandidates.length,
        stopReason: 'no_candidates',
      },
    }
  }

  let nodesExpanded = 1
  let playouts = 0
  let maxDepthTurns = 0
  let stopReason: BotSearchStats['stopReason'] = 'time'
  let lastYieldAt = nowMs()

  for (const line of rootCandidates) {
    const applied = applyTurnLine(state, line)
    if (applied.winner === rootPlayer) {
      reportProgress(nodesExpanded, playouts, maxDepthTurns)
      return {
        moves: line,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded,
          playouts,
          boardEvaluations: evalCounter.count,
          maxDepthTurns,
          rootCandidates: rootCandidates.length,
          stopReason: 'early_win',
        },
      }
    }
  }

  while (nodesExpanded < options.budget.maxNodes && nowMs() - start < options.budget.maxTimeMs) {
    let depthTurns = 0
    let node = root

    while (node.untriedActions.length === 0 && node.children.length > 0 && !node.winner) {
      node = selectUctChild(node, options.explorationC)
      depthTurns += 1
    }

    if (node.untriedActions.length > 0 && !node.winner) {
      const action = node.untriedActions.pop() as Axial[]
      const applied = applyTurnLine(node.state, action)
      const child: SearchNode = {
        state: applied.state,
        winner: applied.winner,
        parent: node,
        actionFromParent: action,
        children: [],
        untriedActions: applied.winner
          ? []
          : enumerateTurnCandidates(applied.state, tuning, Math.max(1, Math.floor(options.turnCandidateCount))),
        visits: 0,
        totalValue: 0,
      }
      node.children.push(child)
      node = child
      nodesExpanded += 1
      depthTurns += 1
    }

    if (depthTurns > maxDepthTurns) {
      maxDepthTurns = depthTurns
    }

    const value = rolloutValue(node, rootPlayer, tuning, options)
    playouts += 1
    let current: SearchNode | null = node
    while (current) {
      current.visits += 1
      current.totalValue += value
      current = current.parent
    }

    if (node.winner === rootPlayer) {
      const rootAction = rootActionFor(node)
      if (rootAction) {
        reportProgress(nodesExpanded, playouts, maxDepthTurns)
        return {
          moves: rootAction,
          stats: {
            mode: 'mcts',
            elapsedMs: nowMs() - start,
            nodesExpanded,
            playouts,
            boardEvaluations: evalCounter.count,
            maxDepthTurns,
            rootCandidates: rootCandidates.length,
            stopReason: 'early_win',
          },
        }
      }
    }

    const now = nowMs()
    if (now - lastYieldAt >= yieldEveryMs) {
      reportProgress(nodesExpanded, playouts, maxDepthTurns)
      await sleep0()
      lastYieldAt = nowMs()
    }
  }

  if (nodesExpanded >= options.budget.maxNodes) {
    stopReason = 'nodes'
  } else if (nowMs() - start >= options.budget.maxTimeMs) {
    stopReason = 'time'
  }

  if (root.children.length === 0) {
    reportProgress(nodesExpanded, playouts, maxDepthTurns)
    return {
      moves: chooseGreedyTurn(state, tuning),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded,
        playouts,
        boardEvaluations: evalCounter.count,
        maxDepthTurns,
        rootCandidates: rootCandidates.length,
        stopReason: 'fallback',
      },
    }
  }

  root.children.sort((a, b) => {
    if (a.visits !== b.visits) return b.visits - a.visits
    const aMean = a.visits > 0 ? a.totalValue / a.visits : Number.NEGATIVE_INFINITY
    const bMean = b.visits > 0 ? b.totalValue / b.visits : Number.NEGATIVE_INFINITY
    return bMean - aMean
  })

  reportProgress(nodesExpanded, playouts, maxDepthTurns)
  return {
    moves: root.children[0].actionFromParent ?? chooseGreedyTurn(state, tuning),
    stats: {
      mode: 'mcts',
      elapsedMs: nowMs() - start,
      nodesExpanded,
      playouts,
      boardEvaluations: evalCounter.count,
      maxDepthTurns,
      rootCandidates: rootCandidates.length,
      stopReason,
    },
  }
}

export function chooseBotTurn(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): Axial[] {
  return chooseBotTurnDetailed(state, tuning, partialOptions).moves
}
