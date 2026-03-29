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
  xPressureMap: Map<string, number>
  oPressureMap: Map<string, number>
  xPressureMax: number
  oPressureMax: number
  xOneTurnWins: number
  oOneTurnWins: number
  xWillWinNextTurn: boolean
  oWillWinNextTurn: boolean
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
  threatSeverityScale: number
  immediateDangerPenalty: number
  oneTurnWinBonus: number
  threatBreadthWeights: number[]
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
  childTurnCandidateCount: number
  maxSimulationTurns: number
  simulationTurnCandidateCount: number
  simulationRadius: number
  simulationTopKFirstMoves: number
  progressiveWideningBase: number
  progressiveWideningScale: number
}

export type BotSearchMode = 'greedy' | 'mcts'

export type BotSearchStats = {
  mode: BotSearchMode
  elapsedMs: number
  nodesExpanded: number
  playouts: number
  boardEvaluations: number
  maxDepthTurns: number
  rootCandidates: number
  stopReason: 'budget_zero' | 'time' | 'nodes' | 'terminal' | 'no_candidates' | 'fallback' | 'early_win'
}

export type BotTurnDecision = {
  moves: Axial[]
  stats: BotSearchStats
}

export const DEFAULT_BOT_TUNING: BotTuning = {
  threatWeights: [0, 0, 6, 36, 860, 860, 20000],
  defenseWeight: 1.25,
  threatDiversityBlend: 0.6,
  threatSeverityScale: 1200,
  immediateDangerPenalty: 150000,
  oneTurnWinBonus: 3500,
  threatBreadthWeights: [0, 0, 0, 0, 0, 0, 0],
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
  turnCandidateCount: 8,
  childTurnCandidateCount: 8,
  maxSimulationTurns: 3,
  simulationTurnCandidateCount: 4,
  simulationRadius: 3,
  simulationTopKFirstMoves: 2,
  progressiveWideningBase: 2,
  progressiveWideningScale: 1.75,
}
