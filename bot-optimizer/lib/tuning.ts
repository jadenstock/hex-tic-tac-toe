import { DEFAULT_BOT_TUNING, type BotTuning } from '../../src/bot/engine.ts'
import type { BotConfig, CliOptions, NormalizedConfig } from './types.ts'

function asNumber(value: unknown, label: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a finite number`)
  }
  return n
}

export function decodeNormalized(normalized: NormalizedConfig | undefined): Partial<BotTuning> {
  if (!normalized) {
    return {}
  }

  const next: Partial<BotTuning> = {}

  if (normalized.threatWeightsMul) {
    if (!Array.isArray(normalized.threatWeightsMul) || normalized.threatWeightsMul.length !== DEFAULT_BOT_TUNING.threatWeights.length) {
      throw new Error(`normalized.threatWeightsMul must have length ${DEFAULT_BOT_TUNING.threatWeights.length}`)
    }
    next.threatWeights = normalized.threatWeightsMul.map((mul, idx) => {
      const m = asNumber(mul, `normalized.threatWeightsMul[${idx}]`)
      if (m < 0) throw new Error(`normalized.threatWeightsMul[${idx}] cannot be negative`)
      return DEFAULT_BOT_TUNING.threatWeights[idx] * m
    })
  }

  if (normalized.threatBreadthWeightsMul) {
    if (!Array.isArray(normalized.threatBreadthWeightsMul) || normalized.threatBreadthWeightsMul.length !== DEFAULT_BOT_TUNING.threatBreadthWeights.length) {
      throw new Error(`normalized.threatBreadthWeightsMul must have length ${DEFAULT_BOT_TUNING.threatBreadthWeights.length}`)
    }
    next.threatBreadthWeights = normalized.threatBreadthWeightsMul.map((mul, idx) => {
      const m = asNumber(mul, `normalized.threatBreadthWeightsMul[${idx}]`)
      if (m < 0) throw new Error(`normalized.threatBreadthWeightsMul[${idx}] cannot be negative`)
      return DEFAULT_BOT_TUNING.threatBreadthWeights[idx] * m
    })
  }

  if (normalized.defenseWeight !== undefined) {
    next.defenseWeight = asNumber(normalized.defenseWeight, 'normalized.defenseWeight')
  }

  const mulFields: Array<[keyof NormalizedConfig, keyof BotTuning, number]> = [
    ['immediateDangerPenaltyMul', 'immediateDangerPenalty', DEFAULT_BOT_TUNING.immediateDangerPenalty],
    ['oneTurnWinBonusMul', 'oneTurnWinBonus', DEFAULT_BOT_TUNING.oneTurnWinBonus],
    ['oneTurnForkBonusMul', 'oneTurnForkBonus', DEFAULT_BOT_TUNING.oneTurnForkBonus],
    ['oneTurnOverlapPenaltyMul', 'oneTurnOverlapPenalty', DEFAULT_BOT_TUNING.oneTurnOverlapPenalty],
    ['threat3ClusterBonusMul', 'threat3ClusterBonus', DEFAULT_BOT_TUNING.threat3ClusterBonus],
    ['threat4ForkBonusMul', 'threat4ForkBonus', DEFAULT_BOT_TUNING.threat4ForkBonus],
    ['threat5ForkBonusMul', 'threat5ForkBonus', DEFAULT_BOT_TUNING.threat5ForkBonus],
  ]

  for (const [key, tuningKey, base] of mulFields) {
    const mul = normalized[key]
    if (mul === undefined) continue
    const m = asNumber(mul, `normalized.${String(key)}`)
    if (m < 0) throw new Error(`normalized.${String(key)} cannot be negative`)
    next[tuningKey] = base * m
  }

  if (normalized.candidateRadius !== undefined) {
    next.candidateRadius = Math.round(asNumber(normalized.candidateRadius, 'normalized.candidateRadius'))
  }

  if (normalized.topKFirstMoves !== undefined) {
    next.topKFirstMoves = Math.round(asNumber(normalized.topKFirstMoves, 'normalized.topKFirstMoves'))
  }

  return next
}

export function mergeTuning(config: BotConfig, opts: CliOptions): BotTuning {
  const decoded = decodeNormalized(config.normalized)
  const raw = config.rawTuning ?? {}

  const tuning: BotTuning = {
    ...DEFAULT_BOT_TUNING,
    ...decoded,
    ...raw,
  }

  tuning.candidateRadius = Math.max(1, Math.min(opts.hardRadiusCap, Math.round(tuning.candidateRadius)))
  tuning.topKFirstMoves = Math.max(1, Math.min(opts.hardTopKCap, Math.round(tuning.topKFirstMoves)))
  tuning.defenseWeight = Math.max(0, Math.min(2, tuning.defenseWeight))
  tuning.threatDiversityBlend = Math.max(0, Math.min(1, tuning.threatDiversityBlend))
  tuning.threatSeverityScale = Math.max(1, Math.min(50000, tuning.threatSeverityScale))
  tuning.threatWeights = tuning.threatWeights.map((value) => Math.max(0, Math.min(20000, value)))
  tuning.threatWeights[5] = tuning.threatWeights[4]
  tuning.immediateDangerPenalty = Math.max(0, Math.min(1_000_000_000, tuning.immediateDangerPenalty))
  tuning.oneTurnWinBonus = Math.max(0, Math.min(1_000_000_000, tuning.oneTurnWinBonus))
  tuning.oneTurnForkBonus = Math.max(0, Math.min(1_000_000_000, tuning.oneTurnForkBonus))
  tuning.oneTurnOverlapPenalty = Math.max(0, Math.min(1_000_000_000, tuning.oneTurnOverlapPenalty))
  tuning.threat3ClusterBonus = Math.max(0, Math.min(1_000_000_000, tuning.threat3ClusterBonus))
  tuning.threat4ForkBonus = Math.max(0, Math.min(1_000_000_000, tuning.threat4ForkBonus))
  tuning.threat5ForkBonus = Math.max(0, Math.min(1_000_000_000, tuning.threat5ForkBonus))
  tuning.threatBreadthWeights = tuning.threatBreadthWeights.map((value) => Math.max(0, Math.min(20000, value)))

  return tuning
}
