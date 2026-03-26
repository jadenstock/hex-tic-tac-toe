import type { BotTuning, Player } from '../../src/bot/engine.ts'

export type JsonMap = Record<string, unknown>

export type NormalizedConfig = {
  threatWeightsMul?: number[]
  threatBreadthWeightsMul?: number[]
  defenseWeight?: number
  immediateDangerPenaltyMul?: number
  oneTurnWinBonusMul?: number
  oneTurnForkBonusMul?: number
  oneTurnOverlapPenaltyMul?: number
  threat3ClusterBonusMul?: number
  threat4ForkBonusMul?: number
  threat5ForkBonusMul?: number
  candidateRadius?: number
  topKFirstMoves?: number
}

export type BotConfig = {
  id: string
  name?: string
  notes?: string
  normalized?: NormalizedConfig
  rawTuning?: Partial<BotTuning>
}

export type Entrant = {
  id: string
  name: string
  notes?: string
  tuning: BotTuning
  sourcePath: string
}

export type EntrantStats = {
  id: string
  name: string
  sourcePath: string
  wins: number
  losses: number
  draws: number
  points: number
  games: number
  turns: number
  placements: number
  totalDecisionMs: number
  avgDecisionMs: number
  avgPlacementDecisionMs: number
  complexityEstimate: number
  score: number
}

export type MatchOutcome = {
  winner: Player | 'draw'
  turns: number
  placements: number
  xDecisionMs: number
  oDecisionMs: number
  xTurns: number
  oTurns: number
  xPlacements: number
  oPlacements: number
  reason: 'win' | 'max_placements' | 'no_candidates' | 'illegal_only'
}

export type CliOptions = {
  populationDir: string
  resultsPath: string
  logPath: string
  maxPlacements: number
  rounds: number
  topK: number
  opponents: 'all'
  hardRadiusCap: number
  hardTopKCap: number
  computePenaltyPerMs: number
}
