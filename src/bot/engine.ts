export type Player = 'X' | 'O'

export type MoveRecord = {
  q: number
  r: number
  mark: Player
}

export type LiveLikeState = {
  moves: Map<string, Player>
  moveHistory: MoveRecord[]
  turn: Player
  placementsLeft: number
}

export type Axial = { q: number; r: number }

export type EvaluationResult = {
  xScore: number
  oScore: number
  xShare: number
  objectiveForX: number
  objectiveForO: number
  xThreats: number[]
  oThreats: number[]
  xOneTurnWins: number
  oOneTurnWins: number
  xWillWinNextTurn: boolean
  oWillWinNextTurn: boolean
}

const WIN_LENGTH = 6
const WIN_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, -1],
]

export type BotTuning = {
  threatWeights: number[]
  threatBreadthWeights: number[]
  defenseWeight: number
  immediateDangerPenalty: number
  oneTurnWinBonus: number
  oneTurnForkBonus: number
  oneTurnOverlapPenalty: number
  threat3ClusterBonus: number
  threat4ForkBonus: number
  threat5ForkBonus: number
  candidateRadius: number
  topKFirstMoves: number
}

export type BotSearchBudget = {
  maxTimeMs: number
  maxNodes: number
}

export type BotSearchOptions = {
  budget: BotSearchBudget
  explorationC: number
  turnCandidateCount: number
  maxSimulationTurns: number
  simulationRadius: number
  simulationTopKFirstMoves: number
}

export type BotSearchMode = 'greedy' | 'mcts'

export type BotSearchStats = {
  mode: BotSearchMode
  elapsedMs: number
  nodesExpanded: number
  playouts: number
  maxDepthTurns: number
  rootCandidates: number
  stopReason: 'budget_zero' | 'time' | 'nodes' | 'terminal' | 'no_candidates' | 'fallback' | 'early_win'
}

export type BotTurnDecision = {
  moves: Axial[]
  stats: BotSearchStats
}

export const DEFAULT_BOT_TUNING: BotTuning = {
  threatWeights: [0, 0, 1, 30.6, 760, 912, 20000],
  threatBreadthWeights: [0, 0, 0, 28.8, 180, 225, 0],
  defenseWeight: 0.72,
  immediateDangerPenalty: 412500,
  oneTurnWinBonus: 8100,
  oneTurnForkBonus: 27300,
  oneTurnOverlapPenalty: 6975,
  threat3ClusterBonus: 120,
  threat4ForkBonus: 17400,
  threat5ForkBonus: 15000,
  candidateRadius: 4,
  topKFirstMoves: 5,
}

export const DEFAULT_BOT_SEARCH_OPTIONS: BotSearchOptions = {
  budget: {
    maxTimeMs: 600,
    maxNodes: 120000,
  },
  explorationC: 1.15,
  turnCandidateCount: 7,
  maxSimulationTurns: 3,
  simulationRadius: 3,
  simulationTopKFirstMoves: 2,
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function fromKey(key: string): Axial {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
}

function scoreThreatCounts(counts: number[], tuning: BotTuning): number {
  let total = 0
  for (let i = 1; i <= WIN_LENGTH; i += 1) {
    total += tuning.threatWeights[i] * counts[i]
    total += tuning.threatBreadthWeights[i] * counts[i] * counts[i]
  }

  // Favor building a few strong concurrent threats over many weak lines.
  total += tuning.threat3ClusterBonus * counts[3] * counts[3]

  // Multiple 4/5 threats are close to forced wins with 2 placements per turn.
  const extra4 = Math.max(0, counts[4] - 1)
  const extra5 = Math.max(0, counts[5] - 1)
  total += tuning.threat4ForkBonus * extra4 * extra4
  total += tuning.threat5ForkBonus * extra5 * extra5

  return total
}

export function evaluateBoardState(moves: Map<string, Player>, tuning: BotTuning = DEFAULT_BOT_TUNING): EvaluationResult {
  const xThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const oThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const xOneTurnFinishRefs = new Map<string, number>()
  const oOneTurnFinishRefs = new Map<string, number>()
  const xOneTurnThreatGroups = new Set<string>()
  const oOneTurnThreatGroups = new Set<string>()

  if (moves.size > 0) {
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

    for (let q = qStart; q <= qEnd; q += 1) {
      for (let r = rStart; r <= rEnd; r += 1) {
        for (const [dq, dr] of WIN_DIRECTIONS) {
          let xCount = 0
          let oCount = 0
          const empties: string[] = []

          for (let i = 0; i < WIN_LENGTH; i += 1) {
            const cellKey = toKey(q + dq * i, r + dr * i)
            const mark = moves.get(cellKey)
            if (mark === 'X') xCount += 1
            if (mark === 'O') oCount += 1
            if (!mark) empties.push(cellKey)
            if (xCount > 0 && oCount > 0) break
          }

          if (xCount > 0 && oCount === 0) {
            xThreats[xCount] += 1
            if (xCount >= 4 && empties.length <= 2) {
              const groupKey = empties.slice().sort().join('|')
              xOneTurnThreatGroups.add(groupKey)
              for (const cell of empties) {
                xOneTurnFinishRefs.set(cell, (xOneTurnFinishRefs.get(cell) ?? 0) + 1)
              }
            }
          } else if (oCount > 0 && xCount === 0) {
            oThreats[oCount] += 1
            if (oCount >= 4 && empties.length <= 2) {
              const groupKey = empties.slice().sort().join('|')
              oOneTurnThreatGroups.add(groupKey)
              for (const cell of empties) {
                oOneTurnFinishRefs.set(cell, (oOneTurnFinishRefs.get(cell) ?? 0) + 1)
              }
            }
          }
        }
      }
    }
  }

  const xOneTurnWins = xOneTurnThreatGroups.size
  const oOneTurnWins = oOneTurnThreatGroups.size
  const xWillWinNextTurn = xOneTurnWins > 0
  const oWillWinNextTurn = oOneTurnWins > 0
  const xOverlap = [...xOneTurnFinishRefs.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const oOverlap = [...oOneTurnFinishRefs.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const xForkPressure = Math.max(0, xOneTurnWins - 1)
  const oForkPressure = Math.max(0, oOneTurnWins - 1)

  const xRawScore =
    scoreThreatCounts(xThreats, tuning) +
    xOneTurnWins * tuning.oneTurnWinBonus +
    xForkPressure * xForkPressure * tuning.oneTurnForkBonus -
    xOverlap * tuning.oneTurnOverlapPenalty
  const oRawScore =
    scoreThreatCounts(oThreats, tuning) +
    oOneTurnWins * tuning.oneTurnWinBonus +
    oForkPressure * oForkPressure * tuning.oneTurnForkBonus -
    oOverlap * tuning.oneTurnOverlapPenalty
  const xScore = Math.max(0, xRawScore)
  const oScore = Math.max(0, oRawScore)
  const total = xScore + oScore
  const xShare = total > 0 ? xScore / total : 0.5

  return {
    xScore,
    oScore,
    xShare,
    objectiveForX: xScore - oScore,
    objectiveForO: oScore - xScore,
    xThreats,
    oThreats,
    xOneTurnWins,
    oOneTurnWins,
    xWillWinNextTurn,
    oWillWinNextTurn,
  }
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
  rankOptions?: { ignoreDangerFlag?: boolean },
): RankedPlacement[] {
  const moveOptions = candidateCells(working.moves, tuning.candidateRadius)
  const ranked = moveOptions.map((option) => {
    const simulated = appendMove(working, option.q, option.r, player)
    const immediateWin = isWinningPlacement(simulated.moves, option.q, option.r, player)
    const evalResult = evaluateBoardState(simulated.moves, tuning)
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

function enumerateTurnCandidates(state: LiveLikeState, tuning: BotTuning, maxCandidates: number): Axial[][] {
  const player = state.turn
  const placements = state.placementsLeft
  if (placements <= 0) return []

  const immediateWin = findImmediateWinningMove(state, player, tuning.candidateRadius)
  if (immediateWin) {
    return [[immediateWin]]
  }

  const firstRanked = rankPlacements(state, player, tuning, { ignoreDangerFlag: placements >= 2 })
  if (firstRanked.length === 0) return []

  const baseEval = evaluateBoardState(state.moves, tuning)
  const baselineOppWins = opponentOneTurnWins(baseEval, player)
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
    const lines = firstRanked.slice(0, capped).map((entry) => {
      const evalResult = evaluateBoardState(entry.simulated.moves, tuning)
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

  const topK = Math.max(1, Math.floor(tuning.topKFirstMoves))
  const firstCandidates = firstRanked.slice(0, Math.min(capped, topK))
  const secondLimit = Math.max(1, Math.floor(capped / Math.max(1, firstCandidates.length)))

  const lines: Array<{ line: Axial[]; objective: number; ownScore: number; immediateWin: boolean; oppOneTurnWins: number }> = []

  for (const first of firstCandidates) {
    const secondRanked = rankPlacements(first.simulated, player, tuning)
    if (secondRanked.length === 0) {
      const evalResult = evaluateBoardState(first.simulated.moves, tuning)
      lines.push({
        line: [first.option],
        objective: objectiveForPlayer(evalResult, player, tuning),
        ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
        immediateWin: first.immediateWin,
        oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      })
      continue
    }

    for (const second of secondRanked.slice(0, secondLimit)) {
      const evalResult = evaluateBoardState(second.simulated.moves, tuning)
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
  const oppOneTurnWins = player === 'X' ? result.oOneTurnWins : result.xOneTurnWins
  const dangerPenalty = options?.ignoreDangerFlag ? 0 : oppOneTurnWins > 0 ? tuning.immediateDangerPenalty : 0
  return (1 - tuning.defenseWeight) * own - tuning.defenseWeight * opp - dangerPenalty
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

  const candidateCount = Math.max(8, Math.floor(tuning.topKFirstMoves) * Math.max(2, placements))
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
    const evalResult = evaluateBoardState(applied.state.moves, tuning)
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
  const result = evaluateBoardState(state.moves, tuning)
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

  if (state.placementsLeft <= 0) {
    return {
      moves: [],
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
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
