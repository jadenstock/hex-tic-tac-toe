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
  type ActiveWindow,
  type AppliedBoardTurn,
  type SearchBoard,
} from './board.ts'
import { evaluateBoardSummary, oneTurnBlockersRequired, type EvaluationSummary } from './evaluation.ts'
import type {
  Axial,
  BotSearchMode,
  BotSearchOptions,
  BotSearchSessionStats,
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
  forcingCache: Map<string, ForcingSolveResult>
  evaluationCacheHits: number
  evaluationCacheMisses: number
  candidateCacheHits: number
  candidateCacheMisses: number
  forcingCacheHits: number
  forcingCacheMisses: number
}

type RankedPlacement = {
  option: Axial
  immediateWin: boolean
  objective: number
  ownScore: number
  oppOneTurnWins: number
}

type CandidateGenerationPolicy = {
  topCellCount: number
  maxLineCount: number
  colonyProbeCount: number
  colonyDistance: number
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
  stateKey: string
}

type ForcingNode = {
  parent: ForcingNode | null
  actionFromParent: Axial[] | null
  children: ForcingNode[]
  stateKey: string
  playerToMove: Player
  attacker: Player
  depthRemaining: number
  status: ForcingSolveResult['status']
}

type SearchStructureSignature = string

type SessionPreparationStats = {
  reusedCurrentRoot: boolean
  reusedFromTree: boolean
  previousTreeNodes: number
  retainedTreeNodes: number
  trimmedTreeNodes: number
  keptAfterMove: boolean
}

export type BotSearchSession = {
  context: SearchContext
  root: ForcingNode | null
  stateIndex: Map<string, ForcingNode[]>
  forcingAttacker: Player | null
  structureSignature: SearchStructureSignature | null
  lastPreparation: SessionPreparationStats
}

type ForcingSolveResult =
  | { status: 'win'; line: Axial[] }
  | { status: 'loss' | 'unknown'; line: null }

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

type ForcingProofBudget = {
  deadlineMs: number
  maxNodes: number
  nodesVisited: number
}

function createSearchContext(): SearchContext {
  return {
    boardEvalCounter: { count: 0 },
    evaluationCache: new Map(),
    candidateCache: new Map(),
    forcingCache: new Map(),
    evaluationCacheHits: 0,
    evaluationCacheMisses: 0,
    candidateCacheHits: 0,
    candidateCacheMisses: 0,
    forcingCacheHits: 0,
    forcingCacheMisses: 0,
  }
}

export function createBotSearchSession(): BotSearchSession {
  return {
    context: createSearchContext(),
    root: null,
    stateIndex: new Map(),
    forcingAttacker: null,
    structureSignature: null,
    lastPreparation: {
      reusedCurrentRoot: false,
      reusedFromTree: false,
      previousTreeNodes: 0,
      retainedTreeNodes: 0,
      trimmedTreeNodes: 0,
      keptAfterMove: false,
    },
  }
}

export function resetBotSearchSession(session: BotSearchSession): void {
  session.context = createSearchContext()
  session.root = null
  session.stateIndex = new Map()
  session.forcingAttacker = null
  session.structureSignature = null
  session.lastPreparation = {
    reusedCurrentRoot: false,
    reusedFromTree: false,
    previousTreeNodes: 0,
    retainedTreeNodes: 0,
    trimmedTreeNodes: 0,
    keptAfterMove: false,
  }
}

function evaluateBoardStateTracked(board: SearchBoard, tuning: BotTuning, context: SearchContext): EvaluationSummary {
  const key = boardStateKey(board)
  const cached = context.evaluationCache.get(key)
  if (cached) {
    context.evaluationCacheHits += 1
    return cached
  }
  context.evaluationCacheMisses += 1
  context.boardEvalCounter.count += 1
  const result = evaluateBoardSummary(board, tuning)
  setBoundedCacheEntry(context.evaluationCache, key, result, MAX_EVALUATION_CACHE_ENTRIES)
  return result
}

function candidateCells(board: SearchBoard, radius: number): Axial[] {
  if (board.moveHistory.length === 0) {
    return [{ q: 0, r: 0 }]
  }

  const candidates = new Map<string, Axial>()
  for (const move of board.moveHistory) {
    const { q, r } = move
    for (let dq = -radius; dq <= radius; dq += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        const ds = -dq - dr
        const distance = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds))
        if (distance > radius) continue
        const candidateQ = q + dq
        const candidateR = r + dr
        const cellKey = toKey(candidateQ, candidateR)
        if (board.moves.has(cellKey) || candidates.has(cellKey)) continue
        candidates.set(cellKey, { q: candidateQ, r: candidateR })
      }
    }
  }

  return [...candidates.values()]
}

function sortAxials(cells: Axial[]): Axial[] {
  return cells.sort((a, b) => (a.q !== b.q ? a.q - b.q : a.r - b.r))
}

const LEAF_OBJECTIVE_GAIN = 3
const TACTICAL_EXPANSION_THRESHOLD = 6
const TACTICAL_EXTENSION_DEPTH = 6
const FORCING_SOLVER_DEPTH = 8
const MAX_EVALUATION_CACHE_ENTRIES = 2_000
const MAX_CANDIDATE_CACHE_ENTRIES = 256
const COLONY_DIRECTIONS: ReadonlyArray<Axial> = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: 1, r: -1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: -1, r: 1 },
]

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

function oneTurnThreatGroups(board: SearchBoard, player: Player): Map<string, number> {
  return player === 'X' ? board.xOneTurnThreatGroupCounts : board.oOneTurnThreatGroupCounts
}

function collectOneTurnFinishCells(board: SearchBoard, player: Player): Set<string> {
  const finishCells = new Set<string>()
  for (const groupKey of oneTurnThreatGroups(board, player).keys()) {
    if (groupKey.length === 0) continue
    const splitIndex = groupKey.indexOf('|')
    if (splitIndex < 0) {
      finishCells.add(groupKey)
      continue
    }
    finishCells.add(groupKey.slice(0, splitIndex))
    finishCells.add(groupKey.slice(splitIndex + 1))
  }
  return finishCells
}

function threatGroupPairs(board: SearchBoard, player: Player): Array<{ first: string; second: string }> {
  const pairs: Array<{ first: string; second: string }> = []
  for (const groupKey of oneTurnThreatGroups(board, player).keys()) {
    if (groupKey.length === 0) continue
    const splitIndex = groupKey.indexOf('|')
    if (splitIndex < 0) {
      pairs.push({ first: groupKey, second: '' })
      continue
    }
    pairs.push({
      first: groupKey.slice(0, splitIndex),
      second: groupKey.slice(splitIndex + 1),
    })
  }
  return pairs
}

function enumerateCoveringMoveSets(
  pairs: Array<{ first: string; second: string }>,
  placementsAvailable: number,
): string[][] {
  if (pairs.length === 0 || placementsAvailable <= 0) return []

  const uniqueCells: string[] = []
  const seen = new Set<string>()
  for (const pair of pairs) {
    if (!seen.has(pair.first)) {
      seen.add(pair.first)
      uniqueCells.push(pair.first)
    }
    if (pair.second.length > 0 && !seen.has(pair.second)) {
      seen.add(pair.second)
      uniqueCells.push(pair.second)
    }
  }

  const coveringSets: string[][] = []
  const current: string[] = []

  const coversAll = (cells: string[]) => {
    for (const pair of pairs) {
      let covered = false
      for (const cell of cells) {
        if (cell === pair.first || cell === pair.second) {
          covered = true
          break
        }
      }
      if (!covered) return false
    }
    return true
  }

  const visit = (startIndex: number) => {
    if (current.length > placementsAvailable) return
    if (current.length > 0 && coversAll(current)) {
      coveringSets.push([...current])
      return
    }
    if (current.length === placementsAvailable) return

    for (let i = startIndex; i < uniqueCells.length; i += 1) {
      current.push(uniqueCells[i])
      visit(i + 1)
      current.pop()
    }
  }

  visit(0)
  return coveringSets
}

function hasImmediateThreats(board: SearchBoard): boolean {
  for (const groupKey of board.xOneTurnThreatGroupCounts.keys()) {
    if (groupKey.length > 0) return true
  }
  for (const groupKey of board.oOneTurnThreatGroupCounts.keys()) {
    if (groupKey.length > 0) return true
  }
  return false
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

function axialDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  const ds = -dq - dr
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds))
}

function collectColonyCandidates(board: SearchBoard, count: number, distance: number): Axial[] {
  if (count <= 0 || distance <= 0 || board.moveHistory.length < 6) return []

  const occupied = board.moveHistory.map((move) => ({ q: move.q, r: move.r }))
  const byDirection = COLONY_DIRECTIONS.map((direction) => {
    let bestAnchor = occupied[0]
    let bestProjection = bestAnchor.q * direction.q + bestAnchor.r * direction.r
    for (let i = 1; i < occupied.length; i += 1) {
      const move = occupied[i]
      const projection = move.q * direction.q + move.r * direction.r
      if (projection > bestProjection) {
        bestProjection = projection
        bestAnchor = move
      }
    }

    const candidate = {
      q: bestAnchor.q + direction.q * distance,
      r: bestAnchor.r + direction.r * distance,
    }

    let nearestDistance = Number.POSITIVE_INFINITY
    for (const move of occupied) {
      nearestDistance = Math.min(nearestDistance, axialDistance(candidate, move))
    }

    return {
      candidate,
      nearestDistance,
      frontier: bestProjection,
    }
  })

  byDirection.sort((a, b) => {
    if (a.nearestDistance !== b.nearestDistance) return b.nearestDistance - a.nearestDistance
    return b.frontier - a.frontier
  })

  const picks: Axial[] = []
  const seen = new Set<string>()
  for (const entry of byDirection) {
    const key = toKey(entry.candidate.q, entry.candidate.r)
    if (board.moves.has(key) || seen.has(key)) continue
    seen.add(key)
    picks.push(entry.candidate)
    if (picks.length >= count) break
  }

  return sortAxials(picks)
}

function collectLegalCandidates(
  board: SearchBoard,
  player: Player,
  tuning: BotTuning,
  targetCount = 0,
  colonyConfig?: { count: number; distance: number },
): Axial[] {
  const opponent: Player = player === 'X' ? 'O' : 'X'
  const ownFinishes = collectOneTurnFinishCells(board, player)
  if (ownFinishes.size > 0) {
    return sortAxials([...ownFinishes].map(fromKey))
  }

  const forcedBlocks = collectOneTurnFinishCells(board, opponent)
  if (forcedBlocks.size > 0) {
    return sortAxials([...forcedBlocks].map(fromKey))
  }

  const connected = collectThreatConnectedCandidates(board, player)
  const defensiveKeys = collectDefensiveResponseCandidateKeys(board, player)
  const colonyCandidates =
    colonyConfig && !hasImmediateThreats(board)
      ? collectColonyCandidates(board, colonyConfig.count, colonyConfig.distance)
      : []
  const primary = uniqueAxials([...connected, ...sortAxials([...defensiveKeys].map(fromKey))])
  const fallback = sortAxials(candidateCells(board, tuning.candidateRadius))
  if (primary.length > 0) {
    if (targetCount <= 0) {
      return uniqueAxials([...primary, ...colonyCandidates])
    }

    const primaryKeys = new Set(primary.map((cell) => toKey(cell.q, cell.r)))
    const needed = Math.max(0, targetCount - primary.length)
    const fallbackSupplement = fallback.filter((cell) => !primaryKeys.has(toKey(cell.q, cell.r))).slice(0, needed)
    return uniqueAxials([...primary, ...colonyCandidates, ...fallbackSupplement])
  }

  return uniqueAxials([...colonyCandidates, ...fallback])
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
    const oppOneTurnWins = opponentOneTurnWins(evalResult, player)
    ranked.push({ option, immediateWin, objective, ownScore, oppOneTurnWins })
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
    policy.maxLineCount,
    policy.colonyProbeCount,
    policy.colonyDistance,
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

  const firstOptions = collectLegalCandidates(board, player, tuning)
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

    const secondOptions = collectLegalCandidates(board, player, tuning)
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
  if (cached) {
    context.candidateCacheHits += 1
    return cloneCandidateLines(cached)
  }
  context.candidateCacheMisses += 1

  const player = board.turn
  const placements = board.placementsLeft

  const winningLines = collectWinningTurnLines(board, player, tuning)
  if (winningLines.length > 0) {
    setBoundedCacheEntry(context.candidateCache, cacheKey, cloneCandidateLines(winningLines), MAX_CANDIDATE_CACHE_ENTRIES)
    return winningLines
  }

  const baseEval = evaluateBoardStateTracked(board, tuning, context)
  const baselineOppWins = opponentOneTurnWins(baseEval, player)

  const topCellCount = Math.max(1, Math.floor(policy.topCellCount))
  const colonyConfig =
    policy.colonyProbeCount > 0 && policy.colonyDistance > 0
      ? { count: policy.colonyProbeCount, distance: policy.colonyDistance }
      : undefined
  const firstPool = collectLegalCandidates(board, player, tuning, topCellCount, colonyConfig)
  const firstRanked = rankPlacements(board, player, tuning, firstPool, context)
  if (firstRanked.length === 0) {
    setBoundedCacheEntry(context.candidateCache, cacheKey, [], MAX_CANDIDATE_CACHE_ENTRIES)
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
    const lines = fallbackPool.map((entry) => ({
      line: [entry.option],
      objective: entry.objective,
      ownScore: entry.ownScore,
      immediateWin: entry.immediateWin,
      oppOneTurnWins: entry.oppOneTurnWins,
    }))
    const pruned = maybeApplyDefensivePruning(lines)
    pruned.sort((a, b) => {
      if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
      if (a.objective !== b.objective) return b.objective - a.objective
      return b.ownScore - a.ownScore
    })
    const picks = pruned.map((entry) => entry.line)
    setBoundedCacheEntry(context.candidateCache, cacheKey, cloneCandidateLines(picks), MAX_CANDIDATE_CACHE_ENTRIES)
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

      const secondPool = collectLegalCandidates(board, player, tuning, topCellCount, colonyConfig)
      const secondRanked = rankPlacements(board, player, tuning, secondPool, context).slice(0, topCellCount)

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

        lines.push({
          line: [first, second],
          objective: secondEntry.objective,
          ownScore: secondEntry.ownScore,
          immediateWin: secondEntry.immediateWin,
          oppOneTurnWins: secondEntry.oppOneTurnWins,
        })
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
    setBoundedCacheEntry(context.candidateCache, cacheKey, cloneCandidateLines(picks), MAX_CANDIDATE_CACHE_ENTRIES)
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
    setBoundedCacheEntry(context.candidateCache, cacheKey, cloneCandidateLines(fallback), MAX_CANDIDATE_CACHE_ENTRIES)
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
  const maxLineCount = Math.max(1, Math.floor(policy.maxLineCount))
  for (const candidate of pruned) {
    const key = canonicalLineKey(candidate.line)
    if (unique.has(key)) continue
    unique.add(key)
    picks.push(candidate.line)
    if (picks.length >= maxLineCount) break
  }

  setBoundedCacheEntry(context.candidateCache, cacheKey, cloneCandidateLines(picks), MAX_CANDIDATE_CACHE_ENTRIES)
  return picks
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key)
  }
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as K | undefined
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

function buildForcingProofBudget(options: BotSearchOptions, startMs: number): ForcingProofBudget {
  const maxTimeMs = Math.max(0, options.budget.maxTimeMs)
  const sliceMs = Math.max(40, Math.min(400, Math.floor(maxTimeMs * 0.2)))
  const maxNodes = Math.max(64, Math.min(1500, Math.floor(options.budget.maxNodes * 0.02)))
  return {
    deadlineMs: startMs + sliceMs,
    maxNodes,
    nodesVisited: 0,
  }
}

function clearTransientSearchCaches(context: SearchContext): void {
  context.candidateCache.clear()
  context.forcingCache.clear()
}

function clearRunSearchCaches(context: SearchContext): void {
  context.evaluationCache.clear()
  clearTransientSearchCaches(context)
}

function resetRunSearchStats(context: SearchContext): void {
  context.boardEvalCounter.count = 0
  context.evaluationCacheHits = 0
  context.evaluationCacheMisses = 0
  context.candidateCacheHits = 0
  context.candidateCacheMisses = 0
  context.forcingCacheHits = 0
  context.forcingCacheMisses = 0
}

function prepareRunSearchContext(context: SearchContext): void {
  clearRunSearchCaches(context)
  resetRunSearchStats(context)
}

function structuralSearchSignature(tuning: BotTuning, options: BotSearchOptions): SearchStructureSignature {
  return JSON.stringify({
    tuning,
    explorationC: options.explorationC,
    turnCandidateCount: options.turnCandidateCount,
    childTurnCandidateCount: options.childTurnCandidateCount,
    maxSimulationTurns: options.maxSimulationTurns,
    simulationTurnCandidateCount: options.simulationTurnCandidateCount,
    simulationRadius: options.simulationRadius,
    simulationTopKFirstMoves: options.simulationTopKFirstMoves,
    progressiveWideningBase: options.progressiveWideningBase,
    progressiveWideningScale: options.progressiveWideningScale,
  })
}

function sessionStateCandidates(session: BotSearchSession, stateKey: string): ForcingNode[] {
  return session.stateIndex.get(stateKey) ?? []
}

function countTreeNodes(root: ForcingNode | null): number {
  if (!root) return 0
  let count = 0
  const queue: ForcingNode[] = [root]
  while (queue.length > 0) {
    const node = queue.pop() as ForcingNode
    count += 1
    for (const child of node.children) queue.push(child)
  }
  return count
}

function computeTreeStats(root: ForcingNode | null) {
  if (!root) {
    return {
      nodeCount: 0,
      leafCount: 0,
      maxDepth: 0,
      averageDepth: 0,
      averageLeafDepth: 0,
    }
  }

  let nodeCount = 0
  let leafCount = 0
  let maxDepth = 0
  let totalDepth = 0
  let totalLeafDepth = 0
  const queue: Array<{ node: ForcingNode; depth: number }> = [{ node: root, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.pop() as { node: ForcingNode; depth: number }
    nodeCount += 1
    totalDepth += current.depth
    if (current.depth > maxDepth) maxDepth = current.depth

    if (current.node.children.length === 0) {
      leafCount += 1
      totalLeafDepth += current.depth
      continue
    }

    for (const child of current.node.children) {
      queue.push({ node: child, depth: current.depth + 1 })
    }
  }

  return {
    nodeCount,
    leafCount,
    maxDepth,
    averageDepth: nodeCount > 0 ? totalDepth / nodeCount : 0,
    averageLeafDepth: leafCount > 0 ? totalLeafDepth / leafCount : 0,
  }
}

function rebuildSessionIndex(session: BotSearchSession): void {
  const next = new Map<string, ForcingNode[]>()
  const queue: ForcingNode[] = session.root ? [session.root] : []

  while (queue.length > 0) {
    const node = queue.pop() as ForcingNode
    const existing = next.get(node.stateKey)
    if (existing) {
      existing.push(node)
    } else {
      next.set(node.stateKey, [node])
    }
    for (const child of node.children) queue.push(child)
  }

  session.stateIndex = next
}

function chooseIndexedNode(nodes: ForcingNode[]): ForcingNode | null {
  if (nodes.length === 0) return null
  let best = nodes[0]
  for (let i = 1; i < nodes.length; i += 1) {
    const candidate = nodes[i]
    if (candidate.depthRemaining > best.depthRemaining) {
      best = candidate
      continue
    }
    if (candidate.depthRemaining === best.depthRemaining && candidate.children.length > best.children.length) {
      best = candidate
    }
  }
  return best
}

function reRootSession(session: BotSearchSession, root: ForcingNode): void {
  root.parent = null
  root.actionFromParent = null
  session.root = root
  rebuildSessionIndex(session)
}

function resetSessionTree(session: BotSearchSession): void {
  session.root = null
  session.stateIndex = new Map()
  session.forcingAttacker = null
  session.context.forcingCache.clear()
}

function ensureSessionStructure(session: BotSearchSession, tuning: BotTuning, options: BotSearchOptions): void {
  const structureSignature = structuralSearchSignature(tuning, options)
  if (session.structureSignature === structureSignature) return
  resetBotSearchSession(session)
  session.structureSignature = structureSignature
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

function exactBlockingResponses(board: SearchBoard, attacker: Player): Axial[][] {
  const pairs = threatGroupPairs(board, attacker)
  if (pairs.length === 0) return []

  const exactCovers = enumerateCoveringMoveSets(pairs, board.placementsLeft)
  const deduped = new Set<string>()
  const lines: Axial[][] = []

  for (const cover of exactCovers) {
    const line = sortAxials(cover.map(fromKey))
    const key = canonicalLineKey(line)
    if (deduped.has(key)) continue
    deduped.add(key)
    lines.push(line)
  }

  return lines
}

function forcingCandidateLines(
  board: SearchBoard,
  attacker: Player,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
): Axial[][] {
  const policy = board.turn === attacker ? rootSearchPolicy(tuning, options) : childSearchPolicy(tuning, options)
  const candidates = enumerateTurnCandidates(board, tuning, policy, context)
  const forcing: Axial[][] = []

  for (const line of candidates) {
    const applied = applyTurnLineToBoard(board, line)
    const key = canonicalLineKey(applied.appliedMoves)
    const immediateWin = applied.winner === attacker
    let keep = immediateWin

    if (!keep && applied.appliedMoves.length > 0) {
      const blockersRequired = oneTurnBlockersRequired(board, attacker)
      const forcingThreshold = Math.min(2, Math.max(1, board.placementsLeft))
      keep = blockersRequired >= forcingThreshold
    }

    undoAppliedTurn(board, applied)
    if (!keep || key.length === 0) continue
    forcing.push(line)
  }

  return forcing
}

function opponentCanWinImmediately(board: SearchBoard, player: Player, tuning: BotTuning): boolean {
  return collectWinningTurnLines(board, player, tuning).length > 0
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
    maxLineCount: Math.max(8, Math.min(candidateCount, 24)),
    colonyProbeCount: 2,
    colonyDistance: 7,
  }
}

function rootSearchPolicy(tuning: BotTuning, options: BotSearchOptions): CandidateGenerationPolicy {
  return {
    topCellCount: widenedTopCellCount(tuning.topKFirstMoves, options.turnCandidateCount, 3),
    maxLineCount: Math.max(8, Math.min(options.turnCandidateCount * 2, 32)),
    colonyProbeCount: 2,
    colonyDistance: 7,
  }
}

function childSearchPolicy(tuning: BotTuning, options: BotSearchOptions): CandidateGenerationPolicy {
  return {
    topCellCount: widenedTopCellCount(tuning.topKFirstMoves, options.childTurnCandidateCount, 2),
    maxLineCount: Math.max(6, Math.min(options.childTurnCandidateCount, 20)),
    colonyProbeCount: 0,
    colonyDistance: 0,
  }
}

function progressiveWideningLimit(node: SearchNode, options: BotSearchOptions): number {
  if (node.candidateActions.length === 0) return 0
  const base = Math.max(1, Math.floor(options.progressiveWideningBase))
  const scale = Math.max(0, options.progressiveWideningScale)
  const limit = base + Math.floor(Math.sqrt(Math.max(0, node.visits)) * scale)
  return Math.max(1, Math.min(node.candidateActions.length, limit))
}

function createRootNode(board: SearchBoard, tuning: BotTuning, options: BotSearchOptions, context: SearchContext): SearchNode {
  return {
    parent: null,
    actionFromParent: null,
    children: [],
    candidateActions: enumerateTurnCandidates(board, tuning, rootSearchPolicy(tuning, options), context),
    nextActionIndex: 0,
    visits: 0,
    totalValue: 0,
    winner: null,
    stateKey: boardStateKey(board),
  }
}

function prepareSearchSession(
  session: BotSearchSession,
  board: SearchBoard,
  attacker: Player,
): void {
  const previousTreeNodes = countTreeNodes(session.root)
  const targetStateKey = boardStateKey(board)
  if (session.root && session.forcingAttacker === attacker && session.root.stateKey === targetStateKey) {
    session.lastPreparation = {
      reusedCurrentRoot: true,
      reusedFromTree: true,
      previousTreeNodes,
      retainedTreeNodes: previousTreeNodes,
      trimmedTreeNodes: 0,
      keptAfterMove: false,
    }
    return
  }

  if (session.forcingAttacker !== attacker) {
    resetSessionTree(session)
    session.lastPreparation = {
      reusedCurrentRoot: false,
      reusedFromTree: false,
      previousTreeNodes,
      retainedTreeNodes: 0,
      trimmedTreeNodes: previousTreeNodes,
      keptAfterMove: false,
    }
    return
  }

  const indexed = chooseIndexedNode(sessionStateCandidates(session, targetStateKey))
  if (indexed) {
    const retainedTreeNodes = countTreeNodes(indexed)
    reRootSession(session, indexed)
    session.lastPreparation = {
      reusedCurrentRoot: false,
      reusedFromTree: true,
      previousTreeNodes,
      retainedTreeNodes,
      trimmedTreeNodes: Math.max(0, previousTreeNodes - retainedTreeNodes),
      keptAfterMove: false,
    }
    return
  }

  resetSessionTree(session)
  session.lastPreparation = {
    reusedCurrentRoot: false,
    reusedFromTree: false,
    previousTreeNodes,
    retainedTreeNodes: 0,
    trimmedTreeNodes: previousTreeNodes,
    keptAfterMove: false,
  }
}

function sortRootChildren(root: SearchNode): void {
  root.children.sort((a, b) => {
    if (a.visits !== b.visits) return b.visits - a.visits
    const aMean = a.visits > 0 ? a.totalValue / a.visits : Number.NEGATIVE_INFINITY
    const bMean = b.visits > 0 ? b.totalValue / b.visits : Number.NEGATIVE_INFINITY
    return bMean - aMean
  })
}

function bestChildAction(node: SearchNode | null): Axial[] | undefined {
  if (!node || node.children.length === 0) return undefined
  sortRootChildren(node)
  return node.children[0].actionFromParent ?? undefined
}

function statusValue(status: ForcingSolveResult['status']): number {
  if (status === 'win') return 1
  if (status === 'loss') return -1
  return 0
}

function valueStatus(value: number): ForcingSolveResult['status'] {
  if (value >= 1) return 'win'
  if (value <= -1) return 'loss'
  return 'unknown'
}

function createForcingNode(
  board: SearchBoard,
  attacker: Player,
  depthRemaining: number,
  parent: ForcingNode | null,
  actionFromParent: Axial[] | null,
): ForcingNode {
  return {
    parent,
    actionFromParent,
    children: [],
    stateKey: boardStateKey(board),
    playerToMove: board.turn,
    attacker,
    depthRemaining,
    status: 'unknown',
  }
}

function sortForcingChildren(node: ForcingNode): void {
  const attackerTurn = node.playerToMove === node.attacker
  node.children.sort((a, b) => {
    const delta = statusValue(b.status) - statusValue(a.status)
    return attackerTurn ? delta : -delta
  })
}

function bestForcingChildAction(node: ForcingNode | null): Axial[] | undefined {
  if (!node || node.children.length === 0) return undefined
  sortForcingChildren(node)
  return node.children[0].actionFromParent ?? undefined
}

function findForcingChildByAction(node: ForcingNode | null, action: Axial[]): ForcingNode | null {
  if (!node) return null
  const actionKey = canonicalLineKey(action)
  for (const child of node.children) {
    if (child.actionFromParent && canonicalLineKey(child.actionFromParent) === actionKey) {
      return child
    }
  }
  return null
}

function buildForcingProofNode(
  board: SearchBoard,
  attacker: Player,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
  budget: ForcingProofBudget,
  depthRemaining: number,
  parent: ForcingNode | null = null,
  actionFromParent: Axial[] | null = null,
  alpha = -1,
  beta = 1,
): ForcingNode {
  const node = createForcingNode(board, attacker, depthRemaining, parent, actionFromParent)
  if (budget.nodesVisited >= budget.maxNodes || nowMs() >= budget.deadlineMs) return node
  budget.nodesVisited += 1
  if (depthRemaining <= 0) return node

  const defender: Player = attacker === 'X' ? 'O' : 'X'
  const currentPlayer = board.turn
  const forcingThreshold = Math.min(2, Math.max(1, board.placementsLeft))
  const blockersRequired = oneTurnBlockersRequired(board, attacker)

  if (currentPlayer === defender && opponentCanWinImmediately(board, defender, tuning)) {
    node.status = 'loss'
    return node
  }

  if (currentPlayer === defender && blockersRequired >= board.placementsLeft + 1) {
    node.status = 'win'
    return node
  }

  if (currentPlayer === attacker) {
    const forcingLines = forcingCandidateLines(board, attacker, tuning, options, context)
    if (forcingLines.length === 0) return node

    let bestValue = -1
    let localAlpha = alpha
    for (const line of forcingLines) {
      const applied = applyTurnLineToBoard(board, line)
      const child = applied.winner === attacker
        ? (() => {
            const leaf = createForcingNode(board, attacker, depthRemaining - 1, node, line)
            leaf.status = 'win'
            return leaf
          })()
        : buildForcingProofNode(board, attacker, tuning, options, context, budget, depthRemaining - 1, node, line, localAlpha, beta)
      undoAppliedTurn(board, applied)
      node.children.push(child)
      const childValue = statusValue(child.status)
      if (childValue > bestValue) bestValue = childValue
      if (bestValue > localAlpha) localAlpha = bestValue
      if (localAlpha >= beta || bestValue === 1) break
    }

    node.status = valueStatus(bestValue)
    sortForcingChildren(node)
    return node
  }

  if (blockersRequired < forcingThreshold) {
    return node
  }

  if (blockersRequired >= board.placementsLeft + 1) {
    node.status = 'win'
    return node
  }

  const blockingLines = exactBlockingResponses(board, attacker)
  if (blockingLines.length === 0) {
    node.status = 'win'
    return node
  }

  let bestValue = 1
  let localBeta = beta
  for (const line of blockingLines) {
    const applied = applyTurnLineToBoard(board, line)
    const child = buildForcingProofNode(board, attacker, tuning, options, context, budget, depthRemaining - 1, node, line, alpha, localBeta)
    undoAppliedTurn(board, applied)
    node.children.push(child)
    const childValue = statusValue(child.status)
    if (childValue < bestValue) bestValue = childValue
    if (bestValue < localBeta) localBeta = bestValue
    if (alpha >= localBeta || bestValue === -1) break
  }

  node.status = valueStatus(bestValue)
  sortForcingChildren(node)
  return node
}

function buildForcingProof(
  board: SearchBoard,
  attacker: Player,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
  startMs: number,
): ForcingNode | null {
  if (!shouldAttemptForcingSolve(board, attacker)) return null
  return buildForcingProofNode(board, attacker, tuning, options, context, buildForcingProofBudget(options, startMs), FORCING_SOLVER_DEPTH)
}

function buildSessionStats(session: BotSearchSession): BotSearchSessionStats {
  return {
    reusedCurrentRoot: session.lastPreparation.reusedCurrentRoot,
    reusedFromTree: session.lastPreparation.reusedFromTree,
    previousTreeNodes: session.lastPreparation.previousTreeNodes,
    retainedTreeNodes: session.lastPreparation.retainedTreeNodes,
    trimmedTreeNodes: session.lastPreparation.trimmedTreeNodes,
    keptAfterMove: session.lastPreparation.keptAfterMove,
    currentTree: computeTreeStats(session.root),
    evaluationCacheSize: session.context.evaluationCache.size,
    candidateCacheSize: session.context.candidateCache.size,
    forcingCacheSize: session.context.forcingCache.size,
    evaluationCacheHits: session.context.evaluationCacheHits,
    evaluationCacheMisses: session.context.evaluationCacheMisses,
    candidateCacheHits: session.context.candidateCacheHits,
    candidateCacheMisses: session.context.candidateCacheMisses,
    forcingCacheHits: session.context.forcingCacheHits,
    forcingCacheMisses: session.context.forcingCacheMisses,
  }
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
  return evaluateNodeForRoot(board, null, rootPlayer, tuning, context)
}

function shouldAttemptForcingSolve(board: SearchBoard, player: Player): boolean {
  if (!hasImmediateThreats(board)) return false
  return oneTurnBlockersRequired(board, player) >= 2
}

function finalizeSessionForDecision(session: BotSearchSession, retainedRoot: ForcingNode | null, attacker: Player | null): void {
  session.lastPreparation.keptAfterMove = retainedRoot !== null
  if (!retainedRoot || !attacker) {
    resetSessionTree(session)
    clearRunSearchCaches(session.context)
    return
  }

  session.root = retainedRoot
  session.forcingAttacker = attacker
  rebuildSessionIndex(session)
  clearRunSearchCaches(session.context)
}

export function inspectBotCandidates(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotCandidateSnapshot {
  const options = normalizeSearchOptions(partialOptions)
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
  const firstPool = collectLegalCandidates(
    board,
    board.turn,
    tuning,
    Math.max(1, Math.floor(policy.topCellCount)),
    policy.colonyProbeCount > 0 && policy.colonyDistance > 0
      ? { count: policy.colonyProbeCount, distance: policy.colonyDistance }
      : undefined,
  )
  const ranked = rankPlacements(board, board.turn, tuning, firstPool, context)
  const topCells = ranked.slice(0, Math.max(1, Math.floor(policy.topCellCount))).map((entry) => entry.option)
  const candidateLines = enumerateTurnCandidates(board, tuning, policy, context)

  return {
    legalCells: firstPool,
    topCells,
    candidateLines,
  }
}

function normalizeSearchOptions(partialOptions: Partial<BotSearchOptions>): BotSearchOptions {
  return {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    ...partialOptions,
    budget: {
      ...DEFAULT_BOT_SEARCH_OPTIONS.budget,
      ...partialOptions.budget,
    },
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

function enrichDecisionWithSession(
  decision: BotTurnDecision,
  session: BotSearchSession,
  stateMoveCount: number,
  retainedRoot?: ForcingNode | null,
  attacker?: Player | null,
  predictedOpponentReply?: Axial[],
): BotTurnDecision {
  finalizeSessionForDecision(session, retainedRoot ?? null, attacker ?? null)
  decision.stats.session = buildSessionStats(session)
  if (predictedOpponentReply && predictedOpponentReply.length > 0) {
    decision.stats.predictedOpponentReply = predictedOpponentReply
  }
  decision.stats.postMoveCount = stateMoveCount + decision.moves.length
  return decision
}

function terminalDecision(start: number, context: SearchContext, mode: BotSearchMode = 'mcts'): BotTurnDecision {
  return {
    moves: [],
    stats: {
      mode,
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

function chooseBotTurnDetailedWithSessionInternal(
  state: LiveLikeState,
  tuning: BotTuning,
  options: BotSearchOptions,
  session: BotSearchSession,
): BotTurnDecision {
  const start = nowMs()
  ensureSessionStructure(session, tuning, options)
  const context = session.context
  prepareRunSearchContext(context)
  const board = createSearchBoard(state)
  const stateMoveCount = board.moves.size
  const rootPlayer = board.turn

  if (shouldAttemptForcingSolve(board, rootPlayer)) {
    prepareSearchSession(session, board, rootPlayer)
  } else {
    const previousTreeNodes = countTreeNodes(session.root)
    resetSessionTree(session)
    session.lastPreparation = {
      reusedCurrentRoot: false,
      reusedFromTree: false,
      previousTreeNodes,
      retainedTreeNodes: 0,
      trimmedTreeNodes: previousTreeNodes,
      keptAfterMove: false,
    }
  }

  if (board.placementsLeft <= 0) {
    return enrichDecisionWithSession(terminalDecision(start, context, 'greedy'), session, stateMoveCount)
  }

  if (findWinner(board)) {
    return enrichDecisionWithSession(terminalDecision(start, context), session, stateMoveCount)
  }

  if (session.root && session.root.playerToMove === rootPlayer && session.root.status === 'win') {
    const forcedLine = bestForcingChildAction(session.root)
    if (forcedLine && forcedLine.length > 0) {
      const retainedRoot = findForcingChildByAction(session.root, forcedLine)
      const predictedOpponentReply = bestForcingChildAction(retainedRoot)
      return enrichDecisionWithSession({
        moves: forcedLine,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded: 0,
          playouts: 0,
          boardEvaluations: context.boardEvalCounter.count,
          maxDepthTurns: 0,
          rootCandidates: session.root.children.length,
          stopReason: 'early_win',
        },
      }, session, stateMoveCount, retainedRoot, rootPlayer, predictedOpponentReply)
    }
  }

  const forcingProof = buildForcingProof(board, rootPlayer, tuning, options, context, start)
  if (forcingProof?.status === 'win') {
    const forcedLine = bestForcingChildAction(forcingProof)
    if (forcedLine && forcedLine.length > 0) {
      const retainedRoot = findForcingChildByAction(forcingProof, forcedLine)
      const predictedOpponentReply = bestForcingChildAction(retainedRoot)
      return enrichDecisionWithSession({
        moves: forcedLine,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded: 1,
          playouts: 0,
          boardEvaluations: context.boardEvalCounter.count,
          maxDepthTurns: 0,
          rootCandidates: forcingProof.children.length,
          stopReason: 'early_win',
        },
      }, session, stateMoveCount, retainedRoot, rootPlayer, predictedOpponentReply)
    }
  }

  if (options.budget.maxTimeMs <= 0 || options.budget.maxNodes <= 0) {
    return enrichDecisionWithSession(chooseGreedyDecision(state, tuning, context), session, stateMoveCount)
  }

  const root = createRootNode(board, tuning, options, context)
  const rootCandidates = root.candidateActions

  if (rootCandidates.length === 0) {
    return enrichDecisionWithSession({
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
    }, session, stateMoveCount)
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
      const predictedOpponentReply = bestChildAction(root.children.find((child) => child.actionFromParent === line) ?? null)
      return enrichDecisionWithSession({
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
      }, session, stateMoveCount, undefined, undefined, predictedOpponentReply)
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
          stateKey: boardStateKey(board),
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
        const predictedOpponentReply = bestChildAction(root.children.find((child) => child.actionFromParent === rootAction) ?? null)
        return enrichDecisionWithSession({
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
        }, session, stateMoveCount, undefined, undefined, predictedOpponentReply)
      }
    }
  }

  if (nodesExpanded >= options.budget.maxNodes) {
    stopReason = 'nodes'
  } else if (nowMs() - start >= options.budget.maxTimeMs) {
    stopReason = 'time'
  }

  if (root.children.length === 0) {
    return enrichDecisionWithSession({
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
    }, session, stateMoveCount)
  }

  sortRootChildren(root)
  return enrichDecisionWithSession({
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
  }, session, stateMoveCount, undefined, undefined, bestChildAction(root.children[0] ?? null))
}

export function chooseBotTurnDetailedWithSession(
  state: LiveLikeState,
  session: BotSearchSession,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotTurnDecision {
  return chooseBotTurnDetailedWithSessionInternal(state, tuning, normalizeSearchOptions(partialOptions), session)
}

export function chooseBotTurnDetailed(
  state: LiveLikeState,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
): BotTurnDecision {
  return chooseBotTurnDetailedWithSession(state, createBotSearchSession(), tuning, partialOptions)
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
  return chooseBotTurnDetailedAsyncWithSession(state, createBotSearchSession(), tuning, partialOptions, progressOptions)
}

export async function chooseBotTurnDetailedAsyncWithSession(
  state: LiveLikeState,
  session: BotSearchSession,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
  partialOptions: Partial<BotSearchOptions> = {},
  progressOptions: SearchProgressOptions = {},
): Promise<BotTurnDecision> {
  const start = nowMs()
  const options = normalizeSearchOptions(partialOptions)
  ensureSessionStructure(session, tuning, options)
  const context = session.context
  prepareRunSearchContext(context)
  const board = createSearchBoard(state)
  const stateMoveCount = board.moves.size
  const rootPlayer = board.turn
  if (shouldAttemptForcingSolve(board, rootPlayer)) {
    prepareSearchSession(session, board, rootPlayer)
  } else {
    const previousTreeNodes = countTreeNodes(session.root)
    resetSessionTree(session)
    session.lastPreparation = {
      reusedCurrentRoot: false,
      reusedFromTree: false,
      previousTreeNodes,
      retainedTreeNodes: 0,
      trimmedTreeNodes: previousTreeNodes,
      keptAfterMove: false,
    }
  }
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
    return enrichDecisionWithSession(terminalDecision(start, context, 'greedy'), session, stateMoveCount)
  }

  if (findWinner(board)) {
    reportProgress(0, 0, 0)
    return enrichDecisionWithSession(terminalDecision(start, context), session, stateMoveCount)
  }

  if (session.root && session.root.playerToMove === rootPlayer && session.root.status === 'win') {
    const forcedLine = bestForcingChildAction(session.root)
    if (forcedLine && forcedLine.length > 0) {
      reportProgress(0, 0, 0)
      const retainedRoot = findForcingChildByAction(session.root, forcedLine)
      const predictedOpponentReply = bestForcingChildAction(retainedRoot)
      return enrichDecisionWithSession({
        moves: forcedLine,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded: 0,
          playouts: 0,
          boardEvaluations: context.boardEvalCounter.count,
          maxDepthTurns: 0,
          rootCandidates: session.root.children.length,
          stopReason: 'early_win',
        },
      }, session, stateMoveCount, retainedRoot, rootPlayer, predictedOpponentReply)
    }
  }

  const forcingProof = buildForcingProof(board, rootPlayer, tuning, options, context, start)
  if (forcingProof?.status === 'win') {
    const forcedLine = bestForcingChildAction(forcingProof)
    if (forcedLine && forcedLine.length > 0) {
      reportProgress(1, 0, 0)
      const retainedRoot = findForcingChildByAction(forcingProof, forcedLine)
      const predictedOpponentReply = bestForcingChildAction(retainedRoot)
      return enrichDecisionWithSession({
        moves: forcedLine,
        stats: {
          mode: 'mcts',
          elapsedMs: nowMs() - start,
          nodesExpanded: 1,
          playouts: 0,
          boardEvaluations: context.boardEvalCounter.count,
          maxDepthTurns: 0,
          rootCandidates: forcingProof.children.length,
          stopReason: 'early_win',
        },
      }, session, stateMoveCount, retainedRoot, rootPlayer, predictedOpponentReply)
    }
  }

  if (options.budget.maxTimeMs <= 0 || options.budget.maxNodes <= 0) {
    const decision = chooseGreedyDecision(boardToLiveState(board), tuning, context)
    reportProgress(0, 0, 0)
    return enrichDecisionWithSession(decision, session, stateMoveCount)
  }

  const root = createRootNode(board, tuning, options, context)
  const rootCandidates = root.candidateActions

  if (root.candidateActions.length === 0) {
    reportProgress(1, 0, 0)
    return enrichDecisionWithSession({
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
    }, session, stateMoveCount)
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
      const predictedOpponentReply = bestChildAction(root.children.find((child) => child.actionFromParent === line) ?? null)
      return enrichDecisionWithSession({
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
      }, session, stateMoveCount, undefined, undefined, predictedOpponentReply)
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
          stateKey: boardStateKey(board),
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
        const predictedOpponentReply = bestChildAction(root.children.find((child) => child.actionFromParent === rootAction) ?? null)
        return enrichDecisionWithSession({
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
        }, session, stateMoveCount, undefined, undefined, predictedOpponentReply)
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
    return enrichDecisionWithSession({
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
    }, session, stateMoveCount)
  }

  sortRootChildren(root)

  reportProgress(nodesExpanded, playouts, maxDepthTurns)
  return enrichDecisionWithSession({
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
  }, session, stateMoveCount, undefined, undefined, bestChildAction(root.children[0] ?? null))
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
  const context = createSearchContext()
  const board = createSearchBoard(state)
  return chooseGreedyTurnOnBoard(board, tuning, context)
}
