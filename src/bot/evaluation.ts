import { createSearchBoard, type SearchBoard } from './board.ts'
import type { BotTuning, EvaluationResult, Player } from './types.ts'
import { DEFAULT_BOT_TUNING } from './types.ts'

export type EvaluationSummary = Pick<
  EvaluationResult,
  'xScore' | 'oScore' | 'xShare' | 'objectiveForX' | 'objectiveForO' | 'xOneTurnWins' | 'oOneTurnWins' | 'xWillWinNextTurn' | 'oWillWinNextTurn'
>

function pressureDiversity(total: number, entropySum: number, size: number): number {
  if (total <= 0 || size <= 1) return 0
  const entropy = Math.log(total) - entropySum / total
  const denom = Math.log(size)
  if (denom <= 0) return 0
  return Math.max(0, Math.min(1, entropy / denom))
}

function scoreOffense(counts: number[], diversity: number, tuning: BotTuning): number {
  const severity = tuning.threatWeights[2] * counts[2] + tuning.threatWeights[3] * counts[3] + tuning.threatWeights[4] * (counts[4] + counts[5])
  if (severity <= 0) return 0
  const scale = Math.max(1, tuning.threatSeverityScale)
  const severityNorm = severity / (severity + scale)
  const blend = Math.max(0, Math.min(1, tuning.threatDiversityBlend))
  return (1 - blend) * severityNorm + blend * diversity
}

function pressureMax(pressure: Map<string, number>): number {
  let max = 0
  for (const value of pressure.values()) {
    if (value > max) max = value
  }
  return max
}

export function evaluateBoardSummary(board: SearchBoard, tuning: BotTuning = DEFAULT_BOT_TUNING): EvaluationSummary {
  const xOneTurnWins = board.xOneTurnThreatGroupCounts.size
  const oOneTurnWins = board.oOneTurnThreatGroupCounts.size
  const xWillWinNextTurn = xOneTurnWins > 0
  const oWillWinNextTurn = oOneTurnWins > 0
  const xDiversity = pressureDiversity(board.xPressureTotal, board.xPressureEntropySum, board.xPressureMap.size)
  const oDiversity = pressureDiversity(board.oPressureTotal, board.oPressureEntropySum, board.oPressureMap.size)
  const xOffense = scoreOffense(board.xThreats, xDiversity, tuning)
  const oOffense = scoreOffense(board.oThreats, oDiversity, tuning)
  const xScore = Math.max(0, xOffense)
  const oScore = Math.max(0, oOffense)
  const total = xScore + oScore
  const xShare = total > 0 ? xScore / total : 0.5

  return {
    xScore,
    oScore,
    xShare,
    objectiveForX: xScore - oScore,
    objectiveForO: oScore - xScore,
    xOneTurnWins,
    oOneTurnWins,
    xWillWinNextTurn,
    oWillWinNextTurn,
  }
}

export function evaluateBoardState(
  boardOrMoves: SearchBoard | Map<string, Player>,
  tuning: BotTuning = DEFAULT_BOT_TUNING,
): EvaluationResult {
  const board = boardOrMoves instanceof Map
    ? createSearchBoard({
        moves: boardOrMoves,
        moveHistory: [],
        turn: 'X',
        placementsLeft: 1,
      })
    : boardOrMoves

  const summary = evaluateBoardSummary(board, tuning)
  const xDiversity = pressureDiversity(board.xPressureTotal, board.xPressureEntropySum, board.xPressureMap.size)
  const oDiversity = pressureDiversity(board.oPressureTotal, board.oPressureEntropySum, board.oPressureMap.size)
  const xOffense = scoreOffense(board.xThreats, xDiversity, tuning)
  const oOffense = scoreOffense(board.oThreats, oDiversity, tuning)

  return {
    ...summary,
    xThreats: [...board.xThreats],
    oThreats: [...board.oThreats],
    xOffense,
    oOffense,
    xDiversity,
    oDiversity,
    xPressureMap: new Map(board.xPressureMap),
    oPressureMap: new Map(board.oPressureMap),
    xPressureMax: pressureMax(board.xPressureMap),
    oPressureMax: pressureMax(board.oPressureMap),
  }
}
