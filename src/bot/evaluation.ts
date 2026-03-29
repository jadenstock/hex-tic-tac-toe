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

function minimumBlockersRequired(threatGroups: Map<string, number>): number {
  const groups: Array<{ first: string; second: string }> = []
  const uniqueCells: string[] = []
  const seenCells = new Set<string>()

  for (const groupKey of threatGroups.keys()) {
    if (groupKey.length === 0) continue
    const splitIndex = groupKey.indexOf('|')
    const first = splitIndex < 0 ? groupKey : groupKey.slice(0, splitIndex)
    const second = splitIndex < 0 ? '' : groupKey.slice(splitIndex + 1)
    groups.push({ first, second })
    if (!seenCells.has(first)) {
      seenCells.add(first)
      uniqueCells.push(first)
    }
    if (second.length > 0 && !seenCells.has(second)) {
      seenCells.add(second)
      uniqueCells.push(second)
    }
  }
  if (groups.length === 0) return 0

  for (const cell of uniqueCells) {
    let coversAll = true
    for (const group of groups) {
      if (group.first !== cell && group.second !== cell) {
        coversAll = false
        break
      }
    }
    if (coversAll) return 1
  }

  for (let i = 0; i < uniqueCells.length; i += 1) {
    const first = uniqueCells[i]
    for (let j = i + 1; j < uniqueCells.length; j += 1) {
      const second = uniqueCells[j]
      let coversAll = true
      for (const group of groups) {
        if (group.first !== first && group.second !== first && group.first !== second && group.second !== second) {
          coversAll = false
          break
        }
      }
      if (coversAll) return 2
    }
  }

  return 3
}

function oneTurnThreatScore(threatGroups: Map<string, number>): number {
  const blockers = minimumBlockersRequired(threatGroups)
  if (blockers <= 0) return 0
  if (blockers === 1) return 0.88
  if (blockers === 2) return 0.96
  return 0.995
}

function scoreOffense(counts: number[], diversity: number, tuning: BotTuning): number {
  const severity = tuning.threatWeights[2] * counts[2] + tuning.threatWeights[3] * counts[3]
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

function analyzeBoard(board: SearchBoard, tuning: BotTuning) {
  const xOneTurnWins = board.xOneTurnThreatGroupCounts.size
  const oOneTurnWins = board.oOneTurnThreatGroupCounts.size
  const xDiversity = pressureDiversity(board.xPressureTotal, board.xPressureEntropySum, board.xPressureMap.size)
  const oDiversity = pressureDiversity(board.oPressureTotal, board.oPressureEntropySum, board.oPressureMap.size)
  const xOffense = scoreOffense(board.xThreats, xDiversity, tuning)
  const oOffense = scoreOffense(board.oThreats, oDiversity, tuning)
  const xScore = Math.max(0, xOffense, oneTurnThreatScore(board.xOneTurnThreatGroupCounts))
  const oScore = Math.max(0, oOffense, oneTurnThreatScore(board.oOneTurnThreatGroupCounts))
  const total = xScore + oScore

  return {
    xOneTurnWins,
    oOneTurnWins,
    xWillWinNextTurn: xOneTurnWins > 0,
    oWillWinNextTurn: oOneTurnWins > 0,
    xDiversity,
    oDiversity,
    xOffense,
    oOffense,
    xScore,
    oScore,
    xShare: total > 0 ? xScore / total : 0.5,
  }
}

export function evaluateBoardSummary(board: SearchBoard, tuning: BotTuning = DEFAULT_BOT_TUNING): EvaluationSummary {
  const analysis = analyzeBoard(board, tuning)

  return {
    xScore: analysis.xScore,
    oScore: analysis.oScore,
    xShare: analysis.xShare,
    objectiveForX: analysis.xScore - analysis.oScore,
    objectiveForO: analysis.oScore - analysis.xScore,
    xOneTurnWins: analysis.xOneTurnWins,
    oOneTurnWins: analysis.oOneTurnWins,
    xWillWinNextTurn: analysis.xWillWinNextTurn,
    oWillWinNextTurn: analysis.oWillWinNextTurn,
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

  const analysis = analyzeBoard(board, tuning)

  return {
    xScore: analysis.xScore,
    oScore: analysis.oScore,
    xShare: analysis.xShare,
    objectiveForX: analysis.xScore - analysis.oScore,
    objectiveForO: analysis.oScore - analysis.xScore,
    xOneTurnWins: analysis.xOneTurnWins,
    oOneTurnWins: analysis.oOneTurnWins,
    xWillWinNextTurn: analysis.xWillWinNextTurn,
    oWillWinNextTurn: analysis.oWillWinNextTurn,
    xThreats: [...board.xThreats],
    oThreats: [...board.oThreats],
    xOffense: analysis.xOffense,
    oOffense: analysis.oOffense,
    xDiversity: analysis.xDiversity,
    oDiversity: analysis.oDiversity,
    xPressureMap: new Map(board.xPressureMap),
    oPressureMap: new Map(board.oPressureMap),
    xPressureMax: pressureMax(board.xPressureMap),
    oPressureMax: pressureMax(board.oPressureMap),
  }
}
