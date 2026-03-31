import { DEFAULT_BOT_SEARCH_OPTIONS, type BotSearchOptions } from './types.ts'

export function buildTimedSearchOptions(timeLimitSeconds: number): BotSearchOptions {
  if (timeLimitSeconds <= 0) {
    return {
      ...DEFAULT_BOT_SEARCH_OPTIONS,
      budget: { maxTimeMs: 0, maxNodes: 0 },
    }
  }

  const seconds = Math.max(0.1, Math.min(12, timeLimitSeconds))
  const normalized = seconds / 12
  return {
    ...DEFAULT_BOT_SEARCH_OPTIONS,
    budget: {
      maxTimeMs: Math.round(seconds * 1000),
      maxNodes: Math.round(50_000 + normalized * 750_000),
    },
    turnCandidateCount: Math.max(5, Math.min(12, 5 + Math.floor(normalized * 7))),
    maxSimulationTurns: Math.max(2, Math.min(6, 2 + Math.floor(normalized * 4))),
    simulationRadius: Math.max(2, Math.min(6, 2 + Math.floor(normalized * 4))),
    simulationTopKFirstMoves: Math.max(1, Math.min(4, 1 + Math.floor(normalized * 3))),
  }
}
