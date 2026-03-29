import {
  applyTurnLineToBoard,
  boardStateKey,
  boardToLiveState,
  createSearchBoard,
  fromKey,
  isWinningPlacement,
  makeBoardMove,
  toKey,
  undoAppliedTurn,
  undoBoardMove,
  windowEmpties,
  windowEmptyCount,
  type ActiveWindow,
  type AppliedBoardTurn,
  type SearchBoard,
} from './board.ts'
import { evaluateBoardSummary, type EvaluationSummary } from './evaluation.ts'
import type {
  Axial,
  BotSearchOptions,
  BotSearchStats,
  BotTuning,
  BotTurnDecision,
  LiveLikeState,
  Player,
} from './types.ts'
import { DEFAULT_BOT_SEARCH_OPTIONS, DEFAULT_BOT_TUNING } from './types.ts'

type SearchContext = {
  boardEvalCounter: { count: number }
  evaluationCache: Map<string, EvaluationSummary>
  candidateCache: Map<string, Axial[][]>
}

type RankedPlacement = {
  option: Axial
  immediateWin: boolean
  objective: number
  ownScore: number
}

type CandidateGenerationPolicy = {
  topCellCount: number
}

type CandidatePool = {
  candidates: Axial[]
  priorityKeys: Set<string>
}

type SearchNode = {
  parent: SearchNode | null
  actionFromParent: Axial[] | null
  children: SearchNode[]
  candidateActions: Axial[][]
  nextActionIndex: number
  visits: number
  totalValue: number
  winner: Player | null
}

export type BotSearchProgress = {
  elapsedMs: number
  nodesExpanded: number
  playouts: number
  boardEvaluations: number
  maxDepthTurns: number
}

export type BotCandidateSnapshot = {
  legalCells: Axial[]
  topCells: Axial[]
  candidateLines: Axial[][]
}

type SearchProgressOptions = {
  onProgress?: (progress: BotSearchProgress) => void
  yieldEveryMs?: number
}

function createSearchContext(): SearchContext {
  return {
    boardEvalCounter: { count: 0 },
    evaluationCache: new Map(),
    candidateCache: new Map(),
  }
}

function evaluateBoardStateTracked(board: SearchBoard, tuning: BotTuning, context: SearchContext): EvaluationSummary {
  const key = boardStateKey(board)
  const cached = context.evaluationCache.get(key)
  if (cached) return cached
  context.boardEvalCounter.count += 1
  const result = evaluateBoardSummary(board, tuning)
  context.evaluationCache.set(key, result)
  return result
}

function candidateCells(board: SearchBoard, radius: number): Axial[] {
  if (board.moves.size === 0) {
    return [{ q: 0, r: 0 }]
  }

  const occupied = new Set(board.moves.keys())
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

const LEAF_OBJECTIVE_GAIN = 3
const TACTICAL_EXPANSION_THRESHOLD = 6
const TACTICAL_EXTENSION_DEPTH = 6

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

function playerWindowCounts(window: ActiveWindow, player: Player): { own: number; opp: number } {
  return player === 'X'
    ? { own: window.xCount, opp: window.oCount }
    : { own: window.oCount, opp: window.xCount }
}

function collectOneTurnFinishCells(board: SearchBoard, player: Player): Set<string> {
  const finishCells = new Set<string>()
  for (const window of board.activeWindows.values()) {
    const counts = playerWindowCounts(window, player)
    if (counts.opp > 0) continue
    if (counts.own >= 4 && windowEmptyCount(window) <= 2) {
      for (const cell of windowEmpties(board, window)) finishCells.add(cell)
    }
  }
  return finishCells
}

function hasImmediateThreats(board: SearchBoard): boolean {
  return collectOneTurnFinishCells(board, 'X').size > 0 || collectOneTurnFinishCells(board, 'O').size > 0
}

function shouldForceTacticalSearch(board: SearchBoard, candidateCount?: number): boolean {
  if (!hasImmediateThreats(board)) return false
  if (candidateCount == null) return true
  return candidateCount <= TACTICAL_EXPANSION_THRESHOLD
}

function collectThreatConnectedCandidates(board: SearchBoard, player: Player): Axial[] {
  if (board.moves.size === 0) return [{ q: 0, r: 0 }]

  const candidates = new Set<string>()
  for (const window of board.activeWindows.values()) {
    const counts = playerWindowCounts(window, player)
    if (counts.own <= 0 || counts.opp > 0) continue
    for (const cell of windowEmpties(board, window)) candidates.add(cell)
  }
  return sortAxials([...candidates].map(fromKey))
}

function collectDefensiveResponseCandidateKeys(board: SearchBoard, player: Player): Set<string> {
  const opponent: Player = player === 'X' ? 'O' : 'X'
  const candidates = new Set<string>()

  for (const window of board.activeWindows.values()) {
    const counts = playerWindowCounts(window, opponent)
    if (counts.opp > 0 || counts.own <= 0) continue
    for (const emptyKey of windowEmpties(board, window)) candidates.add(emptyKey)
  }

  return candidates
}

function collectLegalCandidates(board: SearchBoard, player: Player, tuning: BotTuning, targetCount = 0): CandidatePool {
  const opponent: Player = player === 'X' ? 'O' : 'X'
  const ownFinishes = collectOneTurnFinishCells(board, player)
  if (ownFinishes.size > 0) {
    return {
      candidates: sortAxials([...ownFinishes].map(fromKey)),
      priorityKeys: new Set(),
    }
  }

  const forcedBlocks = collectOneTurnFinishCells(board, opponent)
  if (forcedBlocks.size > 0) {
    return {
      candidates: sortAxials([...forcedBlocks].map(fromKey)),
      priorityKeys: forcedBlocks,
    }
  }

  const connected = collectThreatConnectedCandidates(board, player)
  const defensiveKeys = collectDefensiveResponseCandidateKeys(board, player)
  const primary = uniqueAxials([...connected, ...sortAxials([...defensiveKeys].map(fromKey))])
  const fallback = sortAxials(candidateCells(board, tuning.candidateRadius))
  if (primary.length > 0) {
    if (primary.length >= targetCount || fallback.length === 0) {
      return {
        candidates: primary,
        priorityKeys: new Set([...forcedBlocks, ...defensiveKeys]),
      }
    }

    const primaryKeys = new Set(primary.map((cell) => toKey(cell.q, cell.r)))
    const needed = Math.max(0, targetCount - primary.length)
    const fallbackSupplement = fallback.filter((cell) => !primaryKeys.has(toKey(cell.q, cell.r))).slice(0, needed)
    return {
      candidates: uniqueAxials([...primary, ...fallbackSupplement]),
      priorityKeys: new Set([...forcedBlocks, ...defensiveKeys]),
    }
  }

  return {
    candidates: fallback,
    priorityKeys: new Set([...forcedBlocks, ...defensiveKeys]),
  }
}

function objectiveForPlayer(result: EvaluationSummary, player: Player, tuning: BotTuning): number {
  const own = player === 'X' ? result.xScore : result.oScore
  const opp = player === 'X' ? result.oScore : result.xScore
  return own - tuning.defenseWeight * opp
}

function opponentOneTurnWins(result: EvaluationSummary, player: Player): number {
  return player === 'X' ? result.oOneTurnWins : result.xOneTurnWins
}

function rankPlacements(
  board: SearchBoard,
  player: Player,
  tuning: BotTuning,
  moveOptions: Axial[],
  context: SearchContext,
): RankedPlacement[] {
  const ranked: RankedPlacement[] = []

  for (const option of moveOptions) {
    const undo = makeBoardMove(board, option, player)
    if (!undo) continue
    const immediateWin = undo.winner === player
    const evalResult = evaluateBoardStateTracked(board, tuning, context)
    const objective = immediateWin ? Number.POSITIVE_INFINITY : objectiveForPlayer(evalResult, player, tuning)
    const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore
    ranked.push({ option, immediateWin, objective, ownScore })
    undoBoardMove(board, undo)
  }

  ranked.sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })

  return ranked
}

function canonicalLineKey(line: Axial[]): string {
  if (line.length <= 1) return line.map((cell) => toKey(cell.q, cell.r)).join('|')
  return [...line]
    .sort((a, b) => (a.q !== b.q ? a.q - b.q : a.r - b.r))
    .map((cell) => toKey(cell.q, cell.r))
    .join('|')
}

function cloneCandidateLines(lines: Axial[][]): Axial[][] {
  return lines.map((line) => [...line])
}

function candidatePolicyKey(policy: CandidateGenerationPolicy, tuning: BotTuning): string {
  return [
    policy.topCellCount,
    tuning.candidateRadius,
    tuning.topKFirstMoves,
  ].join('|')
}

function widenedTopCellCount(baseTopK: number, maxCount: number, maxBonus: number): number {
  const cappedMax = Math.max(1, Math.floor(maxCount))
  const base = Math.max(1, Math.min(cappedMax, Math.floor(baseTopK)))
  const spare = Math.max(0, cappedMax - base)
  const bonus = Math.min(maxBonus, Math.ceil(spare / 2))
  return Math.min(cappedMax, base + bonus)
}

function collectWinningTurnLines(board: SearchBoard, player: Player, tuning: BotTuning): Axial[][] {
  if (board.placementsLeft <= 0) return []

  const { candidates: firstOptions } = collectLegalCandidates(board, player, tuning)
  if (firstOptions.length === 0) return []

  const winners: Axial[][] = []
  const seen = new Set<string>()

  for (const first of firstOptions) {
    const firstUndo = makeBoardMove(board, first, player)
    if (!firstUndo) continue
    if (firstUndo.winner === player) {
      const line = [first]
      const key = canonicalLineKey(line)
      if (!seen.has(key)) {
        seen.add(key)
        winners.push(line)
      }
      undoBoardMove(board, firstUndo)
      continue
    }

    if (board.placementsLeft <= 0) {
      undoBoardMove(board, firstUndo)
      continue
    }

    const { candidates: secondOptions } = collectLegalCandidates(board, player, tuning)
    for (const second of secondOptions) {
      const key = canonicalLineKey([first, second])
      if (seen.has(key)) continue
      const secondUndo = makeBoardMove(board, second, player)
      if (!secondUndo) continue
      if (secondUndo.winner === player) {
        const line = [first, second]
        if (!seen.has(key)) {
          seen.add(key)
          winners.push(line)
        }
      }
      undoBoardMove(board, secondUndo)
    }

    undoBoardMove(board, firstUndo)
  }

  return winners
}

function enumerateTurnCandidates(
  board: SearchBoard,
  tuning: BotTuning,
  policy: CandidateGenerationPolicy,
  context: SearchContext,
): Axial[][] {
  if (board.placementsLeft <= 0) return []

  const cacheKey = `${boardStateKey(board)}|${candidatePolicyKey(policy, tuning)}`
  const cached = context.candidateCache.get(cacheKey)
  if (cached) return cloneCandidateLines(cached)

  const player = board.turn
  const placements = board.placementsLeft

  const winningLines = collectWinningTurnLines(board, player, tuning)
  if (winningLines.length > 0) {
    context.candidateCache.set(cacheKey, cloneCandidateLines(winningLines))
    return winningLines
  }

  const baseEval = evaluateBoardStateTracked(board, tuning, context)
  const baselineOppWins = opponentOneTurnWins(baseEval, player)

  const topCellCount = Math.max(1, Math.floor(policy.topCellCount))
  const firstPool = collectLegalCandidates(board, player, tuning, topCellCount)
  const firstRanked = rankPlacements(board, player, tuning, firstPool.candidates, context)
  if (firstRanked.length === 0) {
    context.candidateCache.set(cacheKey, [])
    return []
  }
  const topCellPlacements = firstRanked.slice(0, topCellCount)

  const baselineOppFinish = collectOneTurnFinishCells(board, player === 'X' ? 'O' : 'X')
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
        ? topCellPlacements.filter((entry) => forcedBlocks.has(toKey(entry.option.q, entry.option.r)))
        : topCellPlacements
    const fallbackPool = singleMovePool.length > 0 ? singleMovePool : topCellPlacements
    const lines = fallbackPool.map((entry) => {
      const undo = makeBoardMove(board, entry.option, player)
      if (!undo) {
        return {
          line: [entry.option],
          objective: Number.NEGATIVE_INFINITY,
          ownScore: Number.NEGATIVE_INFINITY,
          immediateWin: false,
          oppOneTurnWins: Number.POSITIVE_INFINITY,
        }
      }
      const evalResult = evaluateBoardStateTracked(board, tuning, context)
      const result = {
        line: [entry.option],
        objective: objectiveForPlayer(evalResult, player, tuning),
        ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
        immediateWin: entry.immediateWin,
        oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      }
      undoBoardMove(board, undo)
      return result
    })
    const pruned = maybeApplyDefensivePruning(lines)
    pruned.sort((a, b) => {
      if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
      if (a.objective !== b.objective) return b.objective - a.objective
      return b.ownScore - a.ownScore
    })
    const picks = pruned.map((entry) => entry.line)
    context.candidateCache.set(cacheKey, cloneCandidateLines(picks))
    return picks
  }

  const lines: Array<{ line: Axial[]; objective: number; ownScore: number; immediateWin: boolean; oppOneTurnWins: number }> = []
  const seenPairKeys = new Set<string>()
  const topCells = topCellPlacements.map((entry) => entry.option)

  if (baselineOppFinish.size > 0) {
    for (const firstEntry of topCellPlacements) {
      const first = firstEntry.option
      const firstUndo = makeBoardMove(board, first, player)
      if (!firstUndo) continue

      const secondPool = collectLegalCandidates(board, player, tuning, topCellCount)
      const secondRanked = rankPlacements(board, player, tuning, secondPool.candidates, context).slice(0, topCellCount)

      if (secondRanked.length === 0) {
        const evalResult = evaluateBoardStateTracked(board, tuning, context)
        lines.push({
          line: [first],
          objective: objectiveForPlayer(evalResult, player, tuning),
          ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
          immediateWin: firstUndo.winner === player,
          oppOneTurnWins: opponentOneTurnWins(evalResult, player),
        })
        undoBoardMove(board, firstUndo)
        continue
      }

      for (const secondEntry of secondRanked) {
        const second = secondEntry.option
        const pairKey = canonicalLineKey([first, second])
        if (seenPairKeys.has(pairKey)) continue
        seenPairKeys.add(pairKey)

        const secondUndo = makeBoardMove(board, second, player)
        if (!secondUndo) continue
        const evalResult = evaluateBoardStateTracked(board, tuning, context)
        lines.push({
          line: [first, second],
          objective: objectiveForPlayer(evalResult, player, tuning),
          ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
          immediateWin: secondUndo.winner === player,
          oppOneTurnWins: opponentOneTurnWins(evalResult, player),
        })
        undoBoardMove(board, secondUndo)
      }

      undoBoardMove(board, firstUndo)
    }

    const pruned = maybeApplyDefensivePruning(lines)
    pruned.sort((a, b) => {
      if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
      if (a.objective !== b.objective) return b.objective - a.objective
      return b.ownScore - a.ownScore
    })
    const picks = pruned.map((entry) => entry.line)
    context.candidateCache.set(cacheKey, cloneCandidateLines(picks))
    return picks
  }

  for (let firstIdx = 0; firstIdx < topCells.length; firstIdx += 1) {
    for (let secondIdx = firstIdx + 1; secondIdx < topCells.length; secondIdx += 1) {
      const first = topCells[firstIdx]
      const second = topCells[secondIdx]
      const pairKey = canonicalLineKey([first, second])
      if (seenPairKeys.has(pairKey)) continue
      seenPairKeys.add(pairKey)

      const firstUndo = makeBoardMove(board, first, player)
      if (!firstUndo) continue
      const secondUndo = makeBoardMove(board, second, player)
      if (!secondUndo) {
        undoBoardMove(board, firstUndo)
        continue
      }

      const evalResult = evaluateBoardStateTracked(board, tuning, context)
      lines.push({
        line: [first, second],
        objective: objectiveForPlayer(evalResult, player, tuning),
        ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
        immediateWin: secondUndo.winner === player,
        oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      })
      undoBoardMove(board, secondUndo)
      undoBoardMove(board, firstUndo)
    }
  }

  if (lines.length === 0) {
    const fallback = topCells.length > 0 ? [[topCells[0]]] : []
    context.candidateCache.set(cacheKey, cloneCandidateLines(fallback))
    return fallback
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
    const key = canonicalLineKey(candidate.line)
    if (unique.has(key)) continue
    unique.add(key)
    picks.push(candidate.line)
  }

  context.candidateCache.set(cacheKey, cloneCandidateLines(picks))
  return picks
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

function evaluateNodeForRoot(board: SearchBoard, winner: Player | null, rootPlayer: Player, tuning: BotTuning, context: SearchContext): number {
  if (winner) return winner === rootPlayer ? 1 : -1
  const result = evaluateBoardStateTracked(board, tuning, context)
  const objective = objectiveForPlayer(result, rootPlayer, tuning)
  return Math.tanh(objective * LEAF_OBJECTIVE_GAIN)
}

function tacticalValue(
  board: SearchBoard,
  winner: Player | null,
  rootPlayer: Player,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
  depthRemaining: number,
  candidateLines?: Axial[][],
  alpha = -1,
  beta = 1,
): number {
  if (winner) return winner === rootPlayer ? 1 : -1
  if (depthRemaining <= 0) return evaluateNodeForRoot(board, null, rootPlayer, tuning, context)

  const lines = candidateLines ?? enumerateTurnCandidates(board, tuning, childSearchPolicy(tuning, options), context)
  if (lines.length === 0 || !shouldForceTacticalSearch(board, lines.length)) {
    return evaluateNodeForRoot(board, null, rootPlayer, tuning, context)
  }

  const maximizing = board.turn === rootPlayer
  let best = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  let localAlpha = alpha
  let localBeta = beta

  for (const line of lines) {
    const applied = applyTurnLineToBoard(board, line)
    const value = tacticalValue(
      board,
      applied.winner,
      rootPlayer,
      tuning,
      options,
      context,
      depthRemaining - 1,
      undefined,
      localAlpha,
      localBeta,
    )
    undoAppliedTurn(board, applied)

    if (maximizing) {
      if (value > best) best = value
      if (best > localAlpha) localAlpha = best
    } else {
      if (value < best) best = value
      if (best < localBeta) localBeta = best
    }

    if (localAlpha >= localBeta || best === 1 || best === -1) break
  }

  return best
}

function selectUctChild(node: SearchNode, explorationC: number): SearchNode {
  const logParent = Math.log(Math.max(1, node.visits))
  let best = node.children[0]
  let bestScore = Number.NEGATIVE_INFINITY

  for (const child of node.children) {
    if (child.visits === 0) return child
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

function findImmediateWinningMove(board: SearchBoard, player: Player, radius: number): Axial | null {
  const options = candidateCells(board, radius)
  for (const option of options) {
    const undo = makeBoardMove(board, option, player)
    if (!undo) continue
    const isWin = undo.winner === player
    undoBoardMove(board, undo)
    if (isWin) return option
  }
  return null
}

function findWinner(board: SearchBoard): Player | null {
  for (const [key, player] of board.moves.entries()) {
    const { q, r } = fromKey(key)
    if (isWinningPlacement(board, q, r, player)) return player
  }
  return null
}

function greedyCandidatePolicy(tuning: BotTuning, candidateCount: number): CandidateGenerationPolicy {
  return {
    topCellCount: widenedTopCellCount(tuning.topKFirstMoves, candidateCount, 3),
  }
}

function rootSearchPolicy(tuning: BotTuning, options: BotSearchOptions): CandidateGenerationPolicy {
  return {
    topCellCount: widenedTopCellCount(tuning.topKFirstMoves, options.turnCandidateCount, 3),
  }
}

function childSearchPolicy(tuning: BotTuning, options: BotSearchOptions): CandidateGenerationPolicy {
  return {
    topCellCount: widenedTopCellCount(tuning.topKFirstMoves, options.childTurnCandidateCount, 2),
  }
}

function rolloutSearchPolicy(options: BotSearchOptions): CandidateGenerationPolicy {
  return {
    topCellCount: Math.max(1, Math.min(Math.floor(options.simulationTurnCandidateCount), Math.floor(options.simulationTopKFirstMoves))),
  }
}

function progressiveWideningLimit(node: SearchNode, options: BotSearchOptions): number {
  if (node.candidateActions.length === 0) return 0
  const base = Math.max(1, Math.floor(options.progressiveWideningBase))
  const scale = Math.max(0, options.progressiveWideningScale)
  const limit = base + Math.floor(Math.sqrt(Math.max(0, node.visits)) * scale)
  return Math.max(1, Math.min(node.candidateActions.length, limit))
}

function chooseGreedyTurnOnBoard(
  board: SearchBoard,
  tuning: BotTuning,
  context: SearchContext,
  candidateCount?: number,
): Axial[] {
  const player = board.turn
  const placements = board.placementsLeft
  if (placements <= 0) return []

  const immediateWin = findImmediateWinningMove(board, player, tuning.candidateRadius)
  if (immediateWin) return [immediateWin]

  const effectiveCandidateCount = candidateCount ?? (placements >= 2 ? 48 : 24)
  const candidateLines = enumerateTurnCandidates(board, tuning, greedyCandidatePolicy(tuning, effectiveCandidateCount), context)
  if (candidateLines.length === 0) return []

  let bestLine = candidateLines[0]
  let bestObjective = Number.NEGATIVE_INFINITY
  let bestOwn = Number.NEGATIVE_INFINITY

  for (const line of candidateLines) {
    const applied = applyTurnLineToBoard(board, line)
    if (applied.winner === player) {
      undoAppliedTurn(board, applied)
      return line
    }
    const evalResult = evaluateBoardStateTracked(board, tuning, context)
    const objective = objectiveForPlayer(evalResult, player, tuning)
    const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore
    if (objective > bestObjective || (objective === bestObjective && ownScore > bestOwn)) {
      bestLine = line
      bestObjective = objective
      bestOwn = ownScore
    }
    undoAppliedTurn(board, applied)
  }

  return bestLine
}

function rolloutValue(
  board: SearchBoard,
  nodeWinner: Player | null,
  rootPlayer: Player,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
): number {
  if (nodeWinner) return nodeWinner === rootPlayer ? 1 : -1

  const tacticalLines = enumerateTurnCandidates(board, tuning, childSearchPolicy(tuning, options), context)
  if (shouldForceTacticalSearch(board, tacticalLines.length)) {
    return tacticalValue(
      board,
      null,
      rootPlayer,
      tuning,
      options,
      context,
      TACTICAL_EXTENSION_DEPTH,
      tacticalLines,
    )
  }

  const rolloutTuning: BotTuning = {
    ...tuning,
    candidateRadius: clamp(options.simulationRadius, 1, 7),
    topKFirstMoves: Math.max(1, Math.floor(options.simulationTopKFirstMoves)),
  }

  const rolloutTurns: AppliedBoardTurn[] = []
  let winner: Player | null = null

  for (let depth = 0; depth < options.maxSimulationTurns; depth += 1) {
    const plan = enumerateTurnCandidates(board, rolloutTuning, rolloutSearchPolicy(options), context)
    const chosen = plan.length > 0 ? plan[0] : chooseGreedyTurnOnBoard(board, rolloutTuning, context, options.simulationTurnCandidateCount)
    if (chosen.length === 0) break
    const applied = applyTurnLineToBoard(board, chosen)
    rolloutTurns.push(applied)
    winner = applied.winner
    if (winner) break
  }

  const value = evaluateNodeForRoot(board, winner, rootPlayer, tuning, context)
  for (let i = rolloutTurns.length - 1; i >= 0; i -= 1) {
    undoAppliedTurn(board, rolloutTurns[i])
  }
  return value
}

export function inspectBotCandidates(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotCandidateSnapshot {
  const options: BotSearchOptions = {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    ...partialOptions,
    budget: {
      ...DEFAULT_BOT_SEARCH_OPTIONS.budget,
      ...partialOptions.budget,
    },
  }
  const context = createSearchContext()
  const board = createSearchBoard(state)
  if (board.placementsLeft <= 0) {
    return {
      legalCells: [],
      topCells: [],
      candidateLines: [],
    }
  }

  const policy = rootSearchPolicy(tuning, options)
  const firstPool = collectLegalCandidates(board, board.turn, tuning, Math.max(1, Math.floor(policy.topCellCount)))
  const ranked = rankPlacements(board, board.turn, tuning, firstPool.candidates, context)
  const topCells = ranked.slice(0, Math.max(1, Math.floor(policy.topCellCount))).map((entry) => entry.option)
  const candidateLines = enumerateTurnCandidates(board, tuning, policy, context)

  return {
    legalCells: firstPool.candidates,
    topCells,
    candidateLines,
  }
}

function chooseGreedyDecision(state: LiveLikeState, tuning: BotTuning, context: SearchContext): BotTurnDecision {
  const start = nowMs()
  const board = createSearchBoard(state)
  const moves = chooseGreedyTurnOnBoard(board, tuning, context)
  return {
    moves,
    stats: {
      mode: 'greedy',
      elapsedMs: nowMs() - start,
      nodesExpanded: 0,
      playouts: 0,
      boardEvaluations: context.boardEvalCounter.count,
      maxDepthTurns: 0,
      rootCandidates: 0,
      stopReason: 'budget_zero',
    },
  }
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
  const context = createSearchContext()
  const board = createSearchBoard(state)

  if (board.placementsLeft <= 0) {
    return {
      moves: [],
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }

  if (options.budget.maxTimeMs <= 0 || options.budget.maxNodes <= 0) {
    return chooseGreedyDecision(state, tuning, context)
  }

  const existingWinner = findWinner(board)
  if (existingWinner) {
    return {
      moves: [],
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }

  const rootPlayer = board.turn
  const rootCandidates = enumerateTurnCandidates(board, tuning, rootSearchPolicy(tuning, options), context)
  const root: SearchNode = {
    parent: null,
    actionFromParent: null,
    children: [],
    candidateActions: rootCandidates,
    nextActionIndex: 0,
    visits: 0,
    totalValue: 0,
    winner: null,
  }

  if (root.candidateActions.length === 0) {
    return {
      moves: chooseGreedyTurnOnBoard(board, tuning, context),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 1,
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'no_candidates',
      },
    }
  }

  let nodesExpanded = 1
  let playouts = 0
  let maxDepthTurns = 0
  let stopReason: BotSearchStats['stopReason'] = 'time'

  for (const line of rootCandidates) {
    const applied = applyTurnLineToBoard(board, line)
    const winner = applied.winner
    undoAppliedTurn(board, applied)
    if (winner === rootPlayer) {
      return {
        moves: line,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded,
          playouts,
          boardEvaluations: context.boardEvalCounter.count,
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
    const appliedPath: AppliedBoardTurn[] = []

    while (!node.winner) {
      const widenLimit = shouldForceTacticalSearch(board, node.candidateActions.length)
        ? node.candidateActions.length
        : progressiveWideningLimit(node, options)
      const canExpand = node.nextActionIndex < widenLimit

      if (canExpand) {
        const action = node.candidateActions[node.nextActionIndex]
        node.nextActionIndex += 1
        const applied = applyTurnLineToBoard(board, action)
        appliedPath.push(applied)
        const child: SearchNode = {
          parent: node,
          actionFromParent: action,
          children: [],
          candidateActions: applied.winner ? [] : enumerateTurnCandidates(board, tuning, childSearchPolicy(tuning, options), context),
          nextActionIndex: 0,
          visits: 0,
          totalValue: 0,
          winner: applied.winner,
        }
        node.children.push(child)
        node = child
        nodesExpanded += 1
        depthTurns += 1
        break
      }

      if (node.children.length === 0) break
      const child = selectUctChild(node, options.explorationC)
      const applied = applyTurnLineToBoard(board, child.actionFromParent as Axial[])
      appliedPath.push(applied)
      node = child
      depthTurns += 1
    }

    if (depthTurns > maxDepthTurns) maxDepthTurns = depthTurns

    const value = rolloutValue(board, node.winner, rootPlayer, tuning, options, context)
    playouts += 1
    let current: SearchNode | null = node
    while (current) {
      current.visits += 1
      current.totalValue += value
      current = current.parent
    }

    const winner = node.winner
    for (let i = appliedPath.length - 1; i >= 0; i -= 1) {
      undoAppliedTurn(board, appliedPath[i])
    }

    if (winner === rootPlayer) {
      const rootAction = rootActionFor(node)
      if (rootAction) {
        return {
          moves: rootAction,
          stats: {
            mode: 'mcts',
            elapsedMs: nowMs() - start,
            nodesExpanded,
            playouts,
            boardEvaluations: context.boardEvalCounter.count,
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
      moves: chooseGreedyTurnOnBoard(board, tuning, context),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded,
        playouts,
        boardEvaluations: context.boardEvalCounter.count,
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
    moves: root.children[0].actionFromParent ?? chooseGreedyTurnOnBoard(board, tuning, context),
    stats: {
      mode: 'mcts',
      elapsedMs: nowMs() - start,
      nodesExpanded,
      playouts,
      boardEvaluations: context.boardEvalCounter.count,
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
  const context = createSearchContext()
  const board = createSearchBoard(state)
  const { onProgress, yieldEveryMs = 16 } = progressOptions

  const reportProgress = (nodesExpanded: number, playouts: number, maxDepthTurns: number) => {
    onProgress?.({
      elapsedMs: nowMs() - start,
      nodesExpanded,
      playouts,
      boardEvaluations: context.boardEvalCounter.count,
      maxDepthTurns,
    })
  }

  if (board.placementsLeft <= 0) {
    reportProgress(0, 0, 0)
    return {
      moves: [],
      stats: {
        mode: 'greedy',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }

  if (options.budget.maxTimeMs <= 0 || options.budget.maxNodes <= 0) {
    const decision = chooseGreedyDecision(boardToLiveState(board), tuning, context)
    reportProgress(0, 0, 0)
    return decision
  }

  const existingWinner = findWinner(board)
  if (existingWinner) {
    reportProgress(0, 0, 0)
    return {
      moves: [],
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 0,
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'terminal',
      },
    }
  }

  const rootPlayer = board.turn
  const rootCandidates = enumerateTurnCandidates(board, tuning, rootSearchPolicy(tuning, options), context)
  const root: SearchNode = {
    parent: null,
    actionFromParent: null,
    children: [],
    candidateActions: rootCandidates,
    nextActionIndex: 0,
    visits: 0,
    totalValue: 0,
    winner: null,
  }

  if (root.candidateActions.length === 0) {
    reportProgress(1, 0, 0)
    return {
      moves: chooseGreedyTurnOnBoard(board, tuning, context),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded: 1,
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
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
    const applied = applyTurnLineToBoard(board, line)
    const winner = applied.winner
    undoAppliedTurn(board, applied)
    if (winner === rootPlayer) {
      reportProgress(nodesExpanded, playouts, maxDepthTurns)
      return {
        moves: line,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded,
          playouts,
          boardEvaluations: context.boardEvalCounter.count,
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
    const appliedPath: AppliedBoardTurn[] = []

    while (!node.winner) {
      const widenLimit = shouldForceTacticalSearch(board, node.candidateActions.length)
        ? node.candidateActions.length
        : progressiveWideningLimit(node, options)
      const canExpand = node.nextActionIndex < widenLimit

      if (canExpand) {
        const action = node.candidateActions[node.nextActionIndex]
        node.nextActionIndex += 1
        const applied = applyTurnLineToBoard(board, action)
        appliedPath.push(applied)
        const child: SearchNode = {
          parent: node,
          actionFromParent: action,
          children: [],
          candidateActions: applied.winner ? [] : enumerateTurnCandidates(board, tuning, childSearchPolicy(tuning, options), context),
          nextActionIndex: 0,
          visits: 0,
          totalValue: 0,
          winner: applied.winner,
        }
        node.children.push(child)
        node = child
        nodesExpanded += 1
        depthTurns += 1
        break
      }

      if (node.children.length === 0) break
      const child = selectUctChild(node, options.explorationC)
      const applied = applyTurnLineToBoard(board, child.actionFromParent as Axial[])
      appliedPath.push(applied)
      node = child
      depthTurns += 1
    }

    if (depthTurns > maxDepthTurns) maxDepthTurns = depthTurns

    const value = rolloutValue(board, node.winner, rootPlayer, tuning, options, context)
    playouts += 1
    let current: SearchNode | null = node
    while (current) {
      current.visits += 1
      current.totalValue += value
      current = current.parent
    }

    const winner = node.winner
    for (let i = appliedPath.length - 1; i >= 0; i -= 1) {
      undoAppliedTurn(board, appliedPath[i])
    }

    if (winner === rootPlayer) {
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
            boardEvaluations: context.boardEvalCounter.count,
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
      moves: chooseGreedyTurnOnBoard(board, tuning, context),
      stats: {
        mode: 'mcts',
        elapsedMs: nowMs() - start,
        nodesExpanded,
        playouts,
        boardEvaluations: context.boardEvalCounter.count,
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
    moves: root.children[0].actionFromParent ?? chooseGreedyTurnOnBoard(board, tuning, context),
    stats: {
      mode: 'mcts',
      elapsedMs: nowMs() - start,
      nodesExpanded,
      playouts,
      boardEvaluations: context.boardEvalCounter.count,
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

export function chooseGreedyTurn(state: LiveLikeState, tuning: BotTuning = DEFAULT_BOT_TUNING): Axial[] {
  const context = createSearchContext()
  const board = createSearchBoard(state)
  return chooseGreedyTurnOnBoard(board, tuning, context)
}
