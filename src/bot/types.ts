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
  xOffense: number
  oOffense: number
  xDiversity: number
  oDiversity: number
  xBreadthSeverity: number
  oBreadthSeverity: number
  xThreat3Breadth: number
  oThreat3Breadth: number
  xThreat3DirectionCount: number
  oThreat3DirectionCount: number
  xThreat3BlockerBurden: number
  oThreat3BlockerBurden: number
  xTriangleCount: number
  oTriangleCount: number
  xRhombusCount: number
  oRhombusCount: number
  xThreat3StructureSeverity: number
  oThreat3StructureSeverity: number
  xThreat3BaseSeverity: number
  oThreat3BaseSeverity: number
  xThreat3BreadthSeverity: number
  oThreat3BreadthSeverity: number
  xUrgencyLoad: number
  oUrgencyLoad: number
  xUrgencyPressure: number
  oUrgencyPressure: number
  xUrgencyDiscount: number
  oUrgencyDiscount: number
  xPressureMap: Map<string, number>
  oPressureMap: Map<string, number>
  xPressureMax: number
  oPressureMax: number
  xOneTurnWins: number
  oOneTurnWins: number
  xWillWinNextTurn: boolean
  oWillWinNextTurn: boolean
}

export type BotPositionEvaluation = {
  xScore: number
  oScore: number
  xNextTurnFinishGroups: number
  oNextTurnFinishGroups: number
  xNextTurnBlockersRequired: number
  oNextTurnBlockersRequired: number
  xForcedNextTurn: boolean
  oForcedNextTurn: boolean
  objectiveForX: number
  objectiveForO: number
}

export const WIN_LENGTH = 6
export const WIN_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, -1],
]

// Threat-2 windows are preemptives: with two placements next turn, they can be
// promoted into true 4/5-threats. Keep their control weight modest but nonzero.
export const THREAT_PRESSURE_WEIGHTS = [0, 0, 0.55, 1, 2.5, 2.5, 0]

export type BotTuning = {
  threatWeights: number[]
  defenseWeight: number
  threatDiversityBlend: number
  tempoDiscountPerStone: number
  threatSeverityScale: number
  immediateDangerPenalty: number
  oneTurnOverlapPenalty: number
  threat3ClusterBreadthFloor: number
  triangleBonus: number
  rhombusBonus: number
  activeBuildMultiplierOne: number
  activeBuildMultiplierTwo: number
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
  childTurnCandidateCount: number
  rootWideningBase: number
  rootWideningAlpha: number
  rootWideningMultiplier: number
  childWideningBase: number
  childWideningAlpha: number
  childWideningMultiplier: number
  muFpuEnabled: boolean
  quiescenceEnabled: boolean
  quiescenceMaxExtraTurns: number
  useStaticLeafEval: boolean
  forcingSolverEnabled: boolean
  maxSimulationTurns: number
  simulationTurnCandidateCount: number
  simulationRadius: number
  simulationTopKFirstMoves: number
}

export type BotSearchTelemetry = {
  rootPriorTopShare: number
  rootBestVisitShare: number
  wideningUnlockCount: number
  muFpuSelectionCount: number
  quiescenceCallCount: number
  quiescenceExtensionCount: number
}

export type BotSearchMode = 'greedy' | 'mcts' | 'beam'

export type BotSearchStats = {
  mode: BotSearchMode
  elapsedMs: number
  nodesExpanded: number
  playouts: number
  boardEvaluations: number
  maxDepthTurns: number
  rootCandidates: number
  stopReason: 'budget_zero' | 'time' | 'nodes' | 'terminal' | 'no_candidates' | 'fallback' | 'early_win' | 'single_candidate' | 'deterministic'
  telemetry?: BotSearchTelemetry
}

export type BotTurnDecision = {
  moves: Axial[]
  stats: BotSearchStats
}

export const DEFAULT_BOT_TUNING: BotTuning = {
  threatWeights: [0, 0, 6, 36, 860, 860, 20000],
  defenseWeight: 1.1,
  threatDiversityBlend: 0.25,
  tempoDiscountPerStone: 0.08,
  threatSeverityScale: 3000,
  immediateDangerPenalty: 150000,
  oneTurnOverlapPenalty: 6975,
  threat3ClusterBreadthFloor: 0.2,
  triangleBonus: 0,
  rhombusBonus: 0,
  activeBuildMultiplierOne: 1.5,
  activeBuildMultiplierTwo: 1,
  candidateRadius: 4,
  topKFirstMoves: 12,
}

export const DEFAULT_BOT_SEARCH_OPTIONS: BotSearchOptions = {
  budget: {
    maxTimeMs: 600,
    maxNodes: 120000,
  },
  explorationC: 1.15,
  turnCandidateCount: 8,
  childTurnCandidateCount: 8,
  rootWideningBase: 4,
  rootWideningAlpha: 0.5,
  rootWideningMultiplier: 1.5,
  childWideningBase: 3,
  childWideningAlpha: 0.5,
  childWideningMultiplier: 1.25,
  muFpuEnabled: true,
  quiescenceEnabled: true,
  quiescenceMaxExtraTurns: 2,
  useStaticLeafEval: true,
  forcingSolverEnabled: true,
  maxSimulationTurns: 3,
  simulationTurnCandidateCount: 4,
  simulationRadius: 3,
  simulationTopKFirstMoves: 2,
}
