import { createSearchBoard, type SearchBoard, windowEmpties, windowEmptyCount } from './board.ts'
import type { BotTuning, EvaluationResult, Player } from './types.ts'
import { DEFAULT_BOT_TUNING, WIN_LENGTH } from './types.ts'

function pressureDiversity(pressure: Map<string, number>): number {
  let total = 0
  for (const value of pressure.values()) total += value
  if (total <= 0 || pressure.size <= 1) return 0

  let entropy = 0
  for (const value of pressure.values()) {
    const p = value / total
    if (p <= 0) continue
    entropy -= p * Math.log(p)
  }

  const denom = Math.log(pressure.size)
  if (denom <= 0) return 0
  return Math.max(0, Math.min(1, entropy / denom))
}

function threatPressureMass(count: number): number {
  if (count === 3) return 1
  if (count === 4 || count === 5) return 2.5
  return 0
}

function scoreOffense(counts: number[], diversity: number, tuning: BotTuning): number {
  const severity = tuning.threatWeights[2] * counts[2] + tuning.threatWeights[3] * counts[3] + tuning.threatWeights[4] * (counts[4] + counts[5])
  if (severity <= 0) return 0
  const scale = Math.max(1, tuning.threatSeverityScale)
  const severityNorm = severity / (severity + scale)
  const blend = Math.max(0, Math.min(1, tuning.threatDiversityBlend))
  return (1 - blend) * severityNorm + blend * diversity
}

function evaluateBoard(board: SearchBoard, tuning: BotTuning): EvaluationResult {
  const xThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const oThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const xOneTurnFinishRefs = new Map<string, number>()
  const oOneTurnFinishRefs = new Map<string, number>()
  const xOneTurnThreatGroups = new Set<string>()
  const oOneTurnThreatGroups = new Set<string>()
  const xPressureMap = new Map<string, number>()
  const oPressureMap = new Map<string, number>()

  for (const window of board.activeWindows.values()) {
    if (window.xCount > 0 && window.oCount === 0) {
      xThreats[window.xCount] += 1
      const emptyCount = windowEmptyCount(window)
      if (window.xCount >= 3 && window.xCount <= 5 && emptyCount > 0) {
        const mass = threatPressureMass(window.xCount)
        const share = mass / emptyCount
        for (const cell of windowEmpties(board, window)) {
          xPressureMap.set(cell, (xPressureMap.get(cell) ?? 0) + share)
        }
      }
      if (window.xCount >= 4 && emptyCount <= 2) {
        const empties = windowEmpties(board, window)
        const groupKey = empties.slice().sort().join('|')
        xOneTurnThreatGroups.add(groupKey)
        for (const cell of empties) {
          xOneTurnFinishRefs.set(cell, (xOneTurnFinishRefs.get(cell) ?? 0) + 1)
        }
      }
    } else if (window.oCount > 0 && window.xCount === 0) {
      oThreats[window.oCount] += 1
      const emptyCount = windowEmptyCount(window)
      if (window.oCount >= 3 && window.oCount <= 5 && emptyCount > 0) {
        const mass = threatPressureMass(window.oCount)
        const share = mass / emptyCount
        for (const cell of windowEmpties(board, window)) {
          oPressureMap.set(cell, (oPressureMap.get(cell) ?? 0) + share)
        }
      }
      if (window.oCount >= 4 && emptyCount <= 2) {
        const empties = windowEmpties(board, window)
        const groupKey = empties.slice().sort().join('|')
        oOneTurnThreatGroups.add(groupKey)
        for (const cell of empties) {
          oOneTurnFinishRefs.set(cell, (oOneTurnFinishRefs.get(cell) ?? 0) + 1)
        }
      }
    }
  }

  const xOneTurnWins = xOneTurnThreatGroups.size
  const oOneTurnWins = oOneTurnThreatGroups.size
  const xWillWinNextTurn = xOneTurnWins > 0
  const oWillWinNextTurn = oOneTurnWins > 0
  const xDiversity = pressureDiversity(xPressureMap)
  const oDiversity = pressureDiversity(oPressureMap)
  const xOffense = scoreOffense(xThreats, xDiversity, tuning)
  const oOffense = scoreOffense(oThreats, oDiversity, tuning)
  const xScore = Math.max(0, xOffense)
  const oScore = Math.max(0, oOffense)
  const total = xScore + oScore
  const xShare = total > 0 ? xScore / total : 0.5

  let xPressureMax = 0
  for (const value of xPressureMap.values()) {
    if (value > xPressureMax) xPressureMax = value
  }
  let oPressureMax = 0
  for (const value of oPressureMap.values()) {
    if (value > oPressureMax) oPressureMax = value
  }

  void xOneTurnFinishRefs
  void oOneTurnFinishRefs

  return {
    xScore,
    oScore,
    xShare,
    objectiveForX: xScore - oScore,
    objectiveForO: oScore - xScore,
    xThreats,
    oThreats,
    xOffense,
    oOffense,
    xDiversity,
    oDiversity,
    xPressureMap,
    oPressureMap,
    xPressureMax,
    oPressureMax,
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
  return evaluateBoard(board, tuning)
}
