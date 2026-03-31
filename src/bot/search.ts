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
  type SearchBoard,
} from './board.ts'
import { evaluateBoardSummary, oneTurnBlockersRequired, type EvaluationSummary } from './evaluation.ts'
import type {
  Axial,
  BotSearchDebugStats,
  BotSearchMode,
  BotSearchOptions,
  BotSearchSessionStats,
  BotSearchStats,
  BotTuning,
  BotTurnDecision,
  LiveLikeState,
  Player,
} from './types.ts'
import { DEFAULT_BOT_SEARCH_OPTIONS, DEFAULT_BOT_TUNING, WIN_DIRECTIONS, WIN_LENGTH } from './types.ts'

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
  debug: BotSearchDebugStats
}

type RankedPlacement = {
  option: Axial
  immediateWin: boolean
  objective: number
  ownScore: number
  oppOneTurnWins: number
}

type RankedAnchorPlacement = RankedPlacement & {
  ownLift: number
  oppDrop: number
}

type RankedLine = {
  line: Axial[]
  objective: number
  ownScore: number
  immediateWin: boolean
  oppOneTurnWins: number
}

type ResidualRankedLine = RankedLine & {
  initialRank: number
  residualObjective: number
  opponentReplyObjective: number
  opponentReply?: Axial[]
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

function createSearchDebugStats(): BotSearchDebugStats {
  return {
    rolloutCalls: 0,
    tacticalExtensionCalls: 0,
    staticLeafEvals: 0,
    tacticalLeafEvals: 0,
    terminalLeafHits: 0,
    leafEvalOwnTurnCount: 0,
    leafEvalOpponentTurnCount: 0,
    rootSetupMs: 0,
    rootImmediateWinScanMs: 0,
    mctsLoopMs: 0,
    selectionExpansionMs: 0,
    rolloutEvalMs: 0,
    backpropUndoMs: 0,
    averagePlayoutMs: 0,
    forcingAttempted: false,
    forcingSolvedWin: false,
    forcingStatus: 'not_attempted',
    rootVisitedChildren: 0,
    rootUnvisitedChildren: 0,
    rootChildrenWithOpponentReplies: 0,
    rootChildrenWithoutOpponentReplies: 0,
    rootAvgOpponentRepliesExplored: 0,
    rootMaxOpponentRepliesExplored: 0,
    rootBestChildVisits: 0,
    rootSecondChildVisits: 0,
    rootBestChildValue: 0,
    rootSecondChildValue: 0,
    rootBestChildVisitShare: 0,
    rootAnchorCount: 0,
    rootFinalLineCount: 0,
    selectedInitialRank: 0,
    selectedResidualRank: 0,
    bestResidualInitialRank: 0,
    rootRankingPreview: [],
  }
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
    debug: createSearchDebugStats(),
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

const FORCING_SOLVER_DEPTH = 8
const MAX_EVALUATION_CACHE_ENTRIES = 2_000
const MAX_CANDIDATE_CACHE_ENTRIES = 256
const MIN_SCORED_CANDIDATE_POINTS = 3
const SINGLE_THREAT_MAX_DISTANCE = 2

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

function canBelongToPlayerWinningSix(board: SearchBoard, q: number, r: number, player: Player): boolean {
  const opponent: Player = player === 'X' ? 'O' : 'X'
  if (board.moves.get(toKey(q, r)) === opponent) return false

  for (const [dq, dr] of WIN_DIRECTIONS) {
    for (let offset = -(WIN_LENGTH - 1); offset <= 0; offset += 1) {
      let blocked = false
      for (let i = 0; i < WIN_LENGTH; i += 1) {
        const key = toKey(q + dq * (offset + i), r + dr * (offset + i))
        if (board.moves.get(key) === opponent) {
          blocked = true
          break
        }
      }
      if (!blocked) return true
    }
  }

  return false
}

function isDeadCandidateHex(board: SearchBoard, q: number, r: number): boolean {
  return !canBelongToPlayerWinningSix(board, q, r, 'X') && !canBelongToPlayerWinningSix(board, q, r, 'O')
}

function collectLiveNeighborCandidates(board: SearchBoard): Axial[] {
  const neighbors: Axial[] = []
  const seen = new Set<string>()

  for (const move of board.moveHistory) {
    if (isDeadCandidateHex(board, move.q, move.r)) continue
    for (const [dq, dr] of WIN_DIRECTIONS) {
      const forward = { q: move.q + dq, r: move.r + dr }
      const backward = { q: move.q - dq, r: move.r - dr }
      for (const cell of [forward, backward]) {
        const key = toKey(cell.q, cell.r)
        if (board.moves.has(key) || seen.has(key) || isDeadCandidateHex(board, cell.q, cell.r)) continue
        seen.add(key)
        neighbors.push(cell)
      }
    }
  }

  return sortAxials(neighbors)
}

function nearestOccupiedDistanceInWindow(
  board: SearchBoard,
  window: ActiveWindow,
  player: Player,
  cellKey: string,
): number {
  const cell = fromKey(cellKey)
  let best = Number.POSITIVE_INFINITY
  for (const windowCellKey of window.cellKeys) {
    if (board.moves.get(windowCellKey) !== player) continue
    best = Math.min(best, axialDistance(cell, fromKey(windowCellKey)))
  }
  return best
}

function collectScoredCandidateEntries(board: SearchBoard): Array<{ cell: Axial; score: number }> {
  const scores = new Map<string, number>()

  for (const window of board.activeWindows.values()) {
    const player = window.xCount > 0 && window.oCount === 0
      ? 'X'
      : window.oCount > 0 && window.xCount === 0
        ? 'O'
        : null
    if (!player) continue

    const threat = player === 'X' ? window.xCount : window.oCount
    if (threat <= 0) continue
    const points = threat >= 2 ? 2 : 1

    for (const emptyKey of windowEmpties(board, window)) {
      if (threat === 1) {
        const distance = nearestOccupiedDistanceInWindow(board, window, player, emptyKey)
        if (distance > SINGLE_THREAT_MAX_DISTANCE) continue
      }
      const empty = fromKey(emptyKey)
      if (isDeadCandidateHex(board, empty.q, empty.r)) continue
      scores.set(emptyKey, (scores.get(emptyKey) ?? 0) + points)
    }
  }

  return [...scores.entries()]
    .map(([key, score]) => ({ cell: fromKey(key), score }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.cell.q !== b.cell.q) return a.cell.q - b.cell.q
      return a.cell.r - b.cell.r
    })
}

function collectLegalCandidates(
  board: SearchBoard,
  player: Player,
  tuning: BotTuning,
  targetCount = 0,
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

  const scored = collectScoredCandidateEntries(board)
  const thresholded = scored.filter((entry) => entry.score >= MIN_SCORED_CANDIDATE_POINTS)
  const fallbackThresholded = thresholded.length > 0 ? thresholded : scored.filter((entry) => entry.score >= 2)
  const selected = fallbackThresholded.length > 0 ? fallbackThresholded : scored
  const liveNeighbors = collectLiveNeighborCandidates(board)

  if (selected.length > 0 || liveNeighbors.length > 0) {
    const cap = targetCount > 0 ? Math.max(targetCount * 3, targetCount + 6) : 24
    return uniqueAxials([...liveNeighbors, ...selected.slice(0, cap).map((entry) => entry.cell)])
  }

  const connected = collectThreatConnectedCandidates(board, player)
  const defensiveKeys = collectDefensiveResponseCandidateKeys(board, player)
  const primary = uniqueAxials([
    ...liveNeighbors,
    ...connected.filter((cell) => !isDeadCandidateHex(board, cell.q, cell.r)),
    ...sortAxials([...defensiveKeys].map(fromKey)).filter((cell) => !isDeadCandidateHex(board, cell.q, cell.r)),
  ])
  if (primary.length > 0) return primary

  return sortAxials(candidateCells(board, Math.min(2, tuning.candidateRadius))).filter((cell) => !isDeadCandidateHex(board, cell.q, cell.r))
}

function objectiveForPlayer(result: EvaluationSummary, player: Player, tuning: BotTuning): number {
  const own = player === 'X' ? result.xScore : result.oScore
  const opp = player === 'X' ? result.oScore : result.xScore
  return own - tuning.defenseWeight * opp
}

function scoreForPlayer(result: EvaluationSummary, player: Player): number {
  return player === 'X' ? result.xScore : result.oScore
}

function scoreForOpponent(result: EvaluationSummary, player: Player): number {
  return player === 'X' ? result.oScore : result.xScore
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

function rankAnchorPlacements(
  board: SearchBoard,
  player: Player,
  tuning: BotTuning,
  moveOptions: Axial[],
  context: SearchContext,
): RankedAnchorPlacement[] {
  const baseline = evaluateBoardStateTracked(board, tuning, context)
  const ownBefore = scoreForPlayer(baseline, player)
  const oppBefore = scoreForOpponent(baseline, player)
  const ranked: RankedAnchorPlacement[] = []

  for (const option of moveOptions) {
    const undo = makeBoardMove(board, option, player)
    if (!undo) continue
    const immediateWin = undo.winner === player
    const evalResult = evaluateBoardStateTracked(board, tuning, context)
    const ownAfter = scoreForPlayer(evalResult, player)
    const oppAfter = scoreForOpponent(evalResult, player)
    ranked.push({
      option,
      immediateWin,
      objective: immediateWin ? Number.POSITIVE_INFINITY : objectiveForPlayer(evalResult, player, tuning),
      ownScore: ownAfter,
      oppOneTurnWins: opponentOneTurnWins(evalResult, player),
      ownLift: ownAfter - ownBefore,
      oppDrop: oppBefore - oppAfter,
    })
    undoBoardMove(board, undo)
  }

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
    tuning.defenseWeight,
    tuning.candidateRadius,
    tuning.topKFirstMoves,
  ].join('|')
}

function scoreAppliedTurn(
  board: SearchBoard,
  player: Player,
  line: Axial[],
  winner: Player | null,
  tuning: BotTuning,
  context: SearchContext,
): RankedLine {
  const evalResult = evaluateBoardStateTracked(board, tuning, context)
  return {
    line,
    objective: winner === player ? Number.POSITIVE_INFINITY : objectiveForPlayer(evalResult, player, tuning),
    ownScore: player === 'X' ? evalResult.xScore : evalResult.oScore,
    immediateWin: winner === player,
    oppOneTurnWins: opponentOneTurnWins(evalResult, player),
  }
}

function sortRankedLines(lines: RankedLine[]): void {
  lines.sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })
}

function pruneDefensivelyCriticalLines(lines: RankedLine[], baselineOppWins: number): RankedLine[] {
  if (baselineOppWins <= 0) return lines

  const fullyBlocked = lines.filter((entry) => entry.oppOneTurnWins === 0)
  if (fullyBlocked.length > 0) return fullyBlocked

  const minOppWins = lines.reduce((min, entry) => Math.min(min, entry.oppOneTurnWins), Number.POSITIVE_INFINITY)
  return lines.filter((entry) => entry.oppOneTurnWins === minOppWins)
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

function enumerateTurnCandidatesBase(
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
  const firstPool = collectLegalCandidates(board, player, tuning, topCellCount)
  const firstRanked = rankPlacements(board, player, tuning, firstPool, context)
  if (firstRanked.length === 0) {
    setBoundedCacheEntry(context.candidateCache, cacheKey, [], MAX_CANDIDATE_CACHE_ENTRIES)
    return []
  }
  const topCellPlacements = firstRanked.slice(0, topCellCount)

  const baselineOppFinish = collectOneTurnFinishCells(board, player === 'X' ? 'O' : 'X')

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
    const pruned = pruneDefensivelyCriticalLines(lines, baselineOppWins)
    sortRankedLines(pruned)
    const picks = pruned.map((entry) => entry.line)
    setBoundedCacheEntry(context.candidateCache, cacheKey, cloneCandidateLines(picks), MAX_CANDIDATE_CACHE_ENTRIES)
    return picks
  }

  const lines: RankedLine[] = []
  const seenPairKeys = new Set<string>()
  const topCells = topCellPlacements.map((entry) => entry.option)

  if (baselineOppFinish.size > 0) {
    for (const firstEntry of topCellPlacements) {
      const first = firstEntry.option
      const firstUndo = makeBoardMove(board, first, player)
      if (!firstUndo) continue

      const secondPool = collectLegalCandidates(board, player, tuning, topCellCount)
      const secondRanked = rankPlacements(board, player, tuning, secondPool, context).slice(0, topCellCount)

      if (secondRanked.length === 0) {
        lines.push(scoreAppliedTurn(board, player, [first], firstUndo.winner, tuning, context))
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

    const pruned = pruneDefensivelyCriticalLines(lines, baselineOppWins)
    sortRankedLines(pruned)
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

  const pruned = pruneDefensivelyCriticalLines(lines, baselineOppWins)
  sortRankedLines(pruned)

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

function enumerateTurnCandidates(
  board: SearchBoard,
  tuning: BotTuning,
  policy: CandidateGenerationPolicy,
  context: SearchContext,
): Axial[][] {
  return enumerateTurnCandidatesBase(board, tuning, policy, context)
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
  context.debug = createSearchDebugStats()
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

function meanChildValue(node: SearchNode): number {
  if (node.visits <= 0) return 0
  return node.totalValue / node.visits
}

function summarizeRootDebug(root: SearchNode | null, rootCandidateCount: number, base: BotSearchDebugStats): BotSearchDebugStats {
  if (!root) return { ...base }

  const children = [...root.children]
  const visitedChildren = children.length
  const unvisitedChildren = Math.max(0, rootCandidateCount - visitedChildren)
  const opponentReplyCounts = children.map((child) => child.children.length)
  const childrenWithOpponentReplies = opponentReplyCounts.filter((count) => count > 0).length
  const childrenWithoutOpponentReplies = visitedChildren - childrenWithOpponentReplies
  const totalOpponentReplies = opponentReplyCounts.reduce((sum, count) => sum + count, 0)
  const sortedByVisits = [...children].sort((a, b) => b.visits - a.visits)
  const bestChild = sortedByVisits[0] ?? null
  const secondChild = sortedByVisits[1] ?? null
  const totalChildVisits = children.reduce((sum, child) => sum + child.visits, 0)

  return {
    ...base,
    averagePlayoutMs: base.rolloutCalls > 0 ? base.mctsLoopMs / base.rolloutCalls : 0,
    rootVisitedChildren: visitedChildren,
    rootUnvisitedChildren: unvisitedChildren,
    rootChildrenWithOpponentReplies: childrenWithOpponentReplies,
    rootChildrenWithoutOpponentReplies: childrenWithoutOpponentReplies,
    rootAvgOpponentRepliesExplored: visitedChildren > 0 ? totalOpponentReplies / visitedChildren : 0,
    rootMaxOpponentRepliesExplored: opponentReplyCounts.length > 0 ? Math.max(...opponentReplyCounts) : 0,
    rootBestChildVisits: bestChild?.visits ?? 0,
    rootSecondChildVisits: secondChild?.visits ?? 0,
    rootBestChildValue: bestChild ? meanChildValue(bestChild) : 0,
    rootSecondChildValue: secondChild ? meanChildValue(secondChild) : 0,
    rootBestChildVisitShare: totalChildVisits > 0 && bestChild ? bestChild.visits / totalChildVisits : 0,
  }
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
    colonyProbeCount: 0,
    colonyDistance: 0,
  }
}

function rootCandidateLineLimit(options: BotSearchOptions): number {
  const requested = Math.max(1, Math.floor(options.turnCandidateCount))
  return Math.max(3, Math.min(requested, 16))
}

function rootSearchPolicy(tuning: BotTuning, options: BotSearchOptions): CandidateGenerationPolicy {
  const lineLimit = rootCandidateLineLimit(options)
  const topCellBudget = Math.min(Math.max(lineLimit + 2, 6), Math.max(lineLimit + 2, 10))
  return {
    topCellCount: widenedTopCellCount(tuning.topKFirstMoves, topCellBudget, 2),
    maxLineCount: Math.max(lineLimit, Math.min(lineLimit * 2, 16)),
    colonyProbeCount: 0,
    colonyDistance: 0,
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

function rootAnchorQuota(lineLimit: number): number {
  return Math.max(2, Math.min(4, Math.ceil(lineLimit / 2)))
}

function sortRankedAnchorsByOwnLift(anchors: RankedAnchorPlacement[]): RankedAnchorPlacement[] {
  return [...anchors].sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.ownLift !== b.ownLift) return b.ownLift - a.ownLift
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })
}

function sortRankedAnchorsByOppDrop(anchors: RankedAnchorPlacement[]): RankedAnchorPlacement[] {
  return [...anchors].sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.oppDrop !== b.oppDrop) return b.oppDrop - a.oppDrop
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })
}

function collectAnchorPlacements(
  board: SearchBoard,
  player: Player,
  tuning: BotTuning,
  legalCells: Axial[],
  lineLimit: number,
  context: SearchContext,
): RankedAnchorPlacement[] {
  const ranked = rankAnchorPlacements(board, player, tuning, legalCells, context)
  if (ranked.length <= 1) return ranked

  const quota = rootAnchorQuota(lineLimit)
  const unique = new Map<string, RankedAnchorPlacement>()

  for (const anchor of sortRankedAnchorsByOwnLift(ranked).slice(0, quota)) {
    unique.set(toKey(anchor.option.q, anchor.option.r), anchor)
  }
  for (const anchor of sortRankedAnchorsByOppDrop(ranked).slice(0, quota)) {
    const key = toKey(anchor.option.q, anchor.option.r)
    if (!unique.has(key)) unique.set(key, anchor)
  }

  if (unique.size === 0) {
    const fallback = [...ranked].sort((a, b) => b.objective - a.objective).slice(0, quota)
    for (const anchor of fallback) unique.set(toKey(anchor.option.q, anchor.option.r), anchor)
  }

  return [...unique.values()].sort((a, b) => {
    if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })
}

function scoreSingleMoveLine(
  board: SearchBoard,
  player: Player,
  move: Axial,
  tuning: BotTuning,
  context: SearchContext,
): RankedLine | null {
  const undo = makeBoardMove(board, move, player)
  if (!undo) return null
  const scored = scoreAppliedTurn(board, player, [move], undo.winner, tuning, context)
  undoBoardMove(board, undo)
  return scored
}

function enumerateAnchoredTurnCandidates(
  board: SearchBoard,
  tuning: BotTuning,
  lineLimit: number,
  secondMoveTargetCount: number,
  context: SearchContext,
): { legalCells: Axial[]; anchors: RankedAnchorPlacement[]; rankedLines: RankedLine[] } {
  const player = board.turn
  const legalCells = collectLegalCandidates(board, player, tuning, Math.max(lineLimit * 3, 18))
  if (legalCells.length === 0) return { legalCells: [], anchors: [], rankedLines: [] }

  const anchors = collectAnchorPlacements(board, player, tuning, legalCells, lineLimit, context)
  if (anchors.length === 0) return { legalCells, anchors: [], rankedLines: [] }

  const baseEval = evaluateBoardStateTracked(board, tuning, context)
  const baselineOppWins = opponentOneTurnWins(baseEval, player)
  const lines: RankedLine[] = []
  const seen = new Set<string>()

  if (board.placementsLeft <= 1) {
    for (const anchor of anchors) {
      const single = scoreSingleMoveLine(board, player, anchor.option, tuning, context)
      if (!single) continue
      const key = canonicalLineKey(single.line)
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(single)
    }
  } else {
    for (const anchor of anchors) {
      const first = anchor.option
      const firstUndo = makeBoardMove(board, first, player)
      if (!firstUndo) continue

      if (firstUndo.winner === player) {
        const winLine = scoreAppliedTurn(board, player, [first], firstUndo.winner, tuning, context)
        const key = canonicalLineKey(winLine.line)
        if (!seen.has(key)) {
          seen.add(key)
          lines.push(winLine)
        }
        undoBoardMove(board, firstUndo)
        continue
      }

      const secondPool = collectLegalCandidates(board, player, tuning, Math.max(secondMoveTargetCount, 18))
      for (const second of secondPool) {
        const pairKey = canonicalLineKey([first, second])
        if (seen.has(pairKey)) continue
        const secondUndo = makeBoardMove(board, second, player)
        if (!secondUndo) continue
        seen.add(pairKey)
        lines.push(scoreAppliedTurn(board, player, [first, second], secondUndo.winner, tuning, context))
        undoBoardMove(board, secondUndo)
      }

      undoBoardMove(board, firstUndo)
    }
  }

  if (lines.length === 0) return { legalCells, anchors, rankedLines: [] }
  const pruned = pruneDefensivelyCriticalLines(lines, baselineOppWins)
  sortRankedLines(pruned)
  return {
    legalCells,
    anchors,
    rankedLines: pruned.slice(0, Math.max(1, lineLimit)),
  }
}

function chooseBestDeterministicReply(
  board: SearchBoard,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
): { line?: Axial[]; objective: number } {
  const replyPlayer = board.turn
  if (board.placementsLeft <= 0) {
    const evalResult = evaluateBoardStateTracked(board, tuning, context)
    return {
      objective: objectiveForPlayer(evalResult, replyPlayer, tuning),
    }
  }

  const replyLimit = Math.max(3, Math.min(options.childTurnCandidateCount, 6))
  const replySearch = enumerateAnchoredTurnCandidates(board, tuning, replyLimit, Math.max(replyLimit * 3, 18), context)
  if (replySearch.rankedLines.length === 0) {
    const evalResult = evaluateBoardStateTracked(board, tuning, context)
    return {
      objective: objectiveForPlayer(evalResult, replyPlayer, tuning),
    }
  }

  let bestLine = replySearch.rankedLines[0].line
  let bestObjective = Number.NEGATIVE_INFINITY
  let bestOwn = Number.NEGATIVE_INFINITY

  for (const candidate of replySearch.rankedLines) {
    const applied = applyTurnLineToBoard(board, candidate.line)
    const evalResult = evaluateBoardStateTracked(board, tuning, context)
    const objective = applied.winner === replyPlayer ? Number.POSITIVE_INFINITY : objectiveForPlayer(evalResult, replyPlayer, tuning)
    const ownScore = scoreForPlayer(evalResult, replyPlayer)
    if (objective > bestObjective || (objective === bestObjective && ownScore > bestOwn)) {
      bestLine = candidate.line
      bestObjective = objective
      bestOwn = ownScore
    }
    undoAppliedTurn(board, applied)
  }

  return { line: bestLine, objective: bestObjective }
}

function applyDeterministicRootDebug(
  context: SearchContext,
  anchors: RankedAnchorPlacement[],
  rankedLines: RankedLine[],
  residualLines: ResidualRankedLine[],
): void {
  context.debug.rootAnchorCount = anchors.length
  context.debug.rootFinalLineCount = residualLines.length
  context.debug.rootVisitedChildren = rankedLines.length
  context.debug.rootUnvisitedChildren = 0
  context.debug.rootChildrenWithOpponentReplies = residualLines.filter((entry) => entry.opponentReply && entry.opponentReply.length > 0).length
  context.debug.rootChildrenWithoutOpponentReplies = Math.max(0, residualLines.length - context.debug.rootChildrenWithOpponentReplies)
  context.debug.rootAvgOpponentRepliesExplored = residualLines.length > 0 ? 1 : 0
  context.debug.rootMaxOpponentRepliesExplored = residualLines.length > 0 ? 1 : 0

  const residualSorted = [...residualLines].sort((a, b) => {
    if (a.residualObjective !== b.residualObjective) return b.residualObjective - a.residualObjective
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })
  const selected = residualSorted[0]
  if (selected) {
    context.debug.selectedInitialRank = selected.initialRank
    context.debug.selectedResidualRank = 1
  }
  const bestResidual = residualSorted[0]
  if (bestResidual) context.debug.bestResidualInitialRank = bestResidual.initialRank

  context.debug.rootRankingPreview = residualSorted.slice(0, 8).map((entry, index) => ({
    initialRank: entry.initialRank,
    residualRank: index + 1,
    initialObjective: entry.objective,
    residualObjective: entry.residualObjective,
    opponentReplyObjective: entry.opponentReplyObjective,
  }))
}

function chooseDeterministicRootDecision(
  board: SearchBoard,
  tuning: BotTuning,
  options: BotSearchOptions,
  context: SearchContext,
): { moves: Axial[]; rootCandidates: number; stopReason: BotSearchStats['stopReason'] } {
  const lineLimit = rootCandidateLineLimit(options)
  const rootSearch = enumerateAnchoredTurnCandidates(board, tuning, lineLimit, Math.max(lineLimit * 4, 20), context)
  context.debug.rootAnchorCount = rootSearch.anchors.length

  if (rootSearch.rankedLines.length === 0) {
    return { moves: [], rootCandidates: 0, stopReason: 'no_candidates' }
  }

  if (rootSearch.rankedLines.length === 1) {
    applyDeterministicRootDebug(context, rootSearch.anchors, rootSearch.rankedLines, [{
      ...rootSearch.rankedLines[0],
      initialRank: 1,
      residualObjective: rootSearch.rankedLines[0].objective,
      opponentReplyObjective: Number.NEGATIVE_INFINITY,
    }])
    return { moves: rootSearch.rankedLines[0].line, rootCandidates: 1, stopReason: 'single_candidate' }
  }

  const residualLines: ResidualRankedLine[] = []
  const rootPlayer = board.turn

  for (let i = 0; i < rootSearch.rankedLines.length; i += 1) {
    const ranked = rootSearch.rankedLines[i]
    const applied = applyTurnLineToBoard(board, ranked.line)
    let residualObjective = ranked.objective
    let opponentReplyObjective = Number.NEGATIVE_INFINITY
    let opponentReply: Axial[] | undefined

    if (applied.winner !== rootPlayer) {
      const reply = chooseBestDeterministicReply(board, tuning, options, context)
      if (reply.line && reply.line.length > 0) {
        opponentReply = reply.line
        opponentReplyObjective = reply.objective
        const replyApplied = applyTurnLineToBoard(board, reply.line)
        const evalResult = evaluateBoardStateTracked(board, tuning, context)
        residualObjective = replyApplied.winner === rootPlayer
          ? Number.POSITIVE_INFINITY
          : replyApplied.winner
            ? Number.NEGATIVE_INFINITY
            : objectiveForPlayer(evalResult, rootPlayer, tuning)
        undoAppliedTurn(board, replyApplied)
      } else {
        const evalResult = evaluateBoardStateTracked(board, tuning, context)
        residualObjective = objectiveForPlayer(evalResult, rootPlayer, tuning)
      }
    }

    residualLines.push({
      ...ranked,
      initialRank: i + 1,
      residualObjective,
      opponentReplyObjective,
      opponentReply,
    })
    undoAppliedTurn(board, applied)
  }

  residualLines.sort((a, b) => {
    if (a.residualObjective !== b.residualObjective) return b.residualObjective - a.residualObjective
    if (a.objective !== b.objective) return b.objective - a.objective
    return b.ownScore - a.ownScore
  })

  applyDeterministicRootDebug(context, rootSearch.anchors, rootSearch.rankedLines, residualLines)
  const best = residualLines[0]
  if (!best) return { moves: [], rootCandidates: 0, stopReason: 'fallback' }
  return {
    moves: best.line,
    rootCandidates: rootSearch.rankedLines.length,
    stopReason: 'deterministic',
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
  context.debug.forcingAttempted = true
  const node = buildForcingProofNode(board, attacker, tuning, options, context, buildForcingProofBudget(options, startMs), FORCING_SOLVER_DEPTH)
  context.debug.forcingStatus = node.status
  context.debug.forcingSolvedWin = node.status === 'win'
  return node
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

  const lineLimit = rootCandidateLineLimit(options)
  const rootSearch = enumerateAnchoredTurnCandidates(board, tuning, lineLimit, Math.max(lineLimit * 4, 20), context)

  return {
    legalCells: rootSearch.legalCells,
    topCells: rootSearch.anchors.map((entry) => entry.option),
    candidateLines: rootSearch.rankedLines.map((entry) => entry.line),
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
  searchRoot?: SearchNode | null,
): BotTurnDecision {
  finalizeSessionForDecision(session, retainedRoot ?? null, attacker ?? null)
  decision.stats.session = buildSessionStats(session)
  decision.stats.debug = summarizeRootDebug(searchRoot ?? null, decision.stats.rootCandidates, session.context.debug)
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

  const rootSetupStart = nowMs()
  const rootDecision = chooseDeterministicRootDecision(board, tuning, options, context)
  context.debug.rootSetupMs += nowMs() - rootSetupStart
  const rootCandidates = rootDecision.rootCandidates

  if (rootCandidates === 0) {
    return enrichDecisionWithSession({
      moves: chooseGreedyTurnOnBoard(board, tuning, context),
      stats: {
        mode: 'beam',
        elapsedMs: nowMs() - start,
        nodesExpanded: Math.max(1, context.debug.rootAnchorCount),
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'no_candidates',
      },
    }, session, stateMoveCount)
  }

  if (rootCandidates === 1) {
    return enrichDecisionWithSession({
      moves: rootDecision.moves,
      stats: {
        mode: 'beam',
        elapsedMs: nowMs() - start,
        nodesExpanded: Math.max(1, context.debug.rootAnchorCount),
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 1,
        stopReason: 'single_candidate',
      },
    }, session, stateMoveCount)
  }

  return enrichDecisionWithSession({
    moves: rootDecision.moves,
    stats: {
      mode: 'beam',
      elapsedMs: nowMs() - start,
      nodesExpanded: Math.max(1, context.debug.rootAnchorCount + context.debug.rootFinalLineCount),
      playouts: 0,
      boardEvaluations: context.boardEvalCounter.count,
      maxDepthTurns: rootCandidates > 0 ? 2 : 0,
      rootCandidates,
      stopReason: rootDecision.stopReason,
    },
  }, session, stateMoveCount)
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
  const { onProgress } = progressOptions

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

  const rootSetupStart = nowMs()
  const rootDecision = chooseDeterministicRootDecision(board, tuning, options, context)
  context.debug.rootSetupMs += nowMs() - rootSetupStart
  const rootCandidates = rootDecision.rootCandidates

  if (rootCandidates === 0) {
    reportProgress(1, 0, 0)
    return enrichDecisionWithSession({
      moves: chooseGreedyTurnOnBoard(board, tuning, context),
      stats: {
        mode: 'beam',
        elapsedMs: nowMs() - start,
        nodesExpanded: Math.max(1, context.debug.rootAnchorCount),
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 0,
        stopReason: 'no_candidates',
      },
    }, session, stateMoveCount)
  }

  if (rootCandidates === 1) {
    reportProgress(1, 0, 0)
    return enrichDecisionWithSession({
      moves: rootDecision.moves,
      stats: {
        mode: 'beam',
        elapsedMs: nowMs() - start,
        nodesExpanded: Math.max(1, context.debug.rootAnchorCount),
        playouts: 0,
        boardEvaluations: context.boardEvalCounter.count,
        maxDepthTurns: 0,
        rootCandidates: 1,
        stopReason: 'single_candidate',
      },
    }, session, stateMoveCount)
  }

  reportProgress(Math.max(1, context.debug.rootAnchorCount + context.debug.rootFinalLineCount), 0, rootCandidates > 0 ? 2 : 0)
  return enrichDecisionWithSession({
    moves: rootDecision.moves,
    stats: {
      mode: 'beam',
      elapsedMs: nowMs() - start,
      nodesExpanded: Math.max(1, context.debug.rootAnchorCount + context.debug.rootFinalLineCount),
      playouts: 0,
      boardEvaluations: context.boardEvalCounter.count,
      maxDepthTurns: rootCandidates > 0 ? 2 : 0,
      rootCandidates,
      stopReason: rootDecision.stopReason,
    },
  }, session, stateMoveCount)
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
