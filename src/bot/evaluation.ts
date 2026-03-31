import { createSearchBoard, type SearchBoard } from './board.ts'
import type { BotTuning, EvaluationResult, Player } from './types.ts'
import { DEFAULT_BOT_TUNING, WIN_DIRECTIONS, WIN_LENGTH } from './types.ts'

export type EvaluationSummary = Pick<
  EvaluationResult,
  'xScore' | 'oScore' | 'xShare' | 'objectiveForX' | 'objectiveForO' | 'xOneTurnWins' | 'oOneTurnWins' | 'xWillWinNextTurn' | 'oWillWinNextTurn'
>

type ThreatWindow = {
  threat: number
  directionIndex: number
  cutSet: string[]
}

type ThreatLevelStats = {
  windowCount: number
  blockerBurden: number
  resilience: number
  directionCount: number
  pressure: number
}

type ThreatProfile = {
  levels: ThreatLevelStats[]
  totalPressure: number
}

function countStones(board: SearchBoard, player: Player): number {
  let count = 0
  for (const mark of board.moves.values()) {
    if (mark === player) count += 1
  }
  return count
}

function applyTempoDiscount(score: number, ownStones: number, oppStones: number, tuning: BotTuning): number {
  if (score <= 0) return 0
  const delta = Math.max(0, ownStones - oppStones)
  if (delta <= 0) return score
  const k = Math.max(0, tuning.tempoDiscountPerStone)
  return score / (1 + k * delta)
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

export function oneTurnBlockersRequired(board: SearchBoard, player: Player): number {
  return minimumBlockersRequired(
    player === 'X' ? board.xOneTurnThreatGroupCounts : board.oOneTurnThreatGroupCounts,
  )
}

function pressureMax(pressure: Map<string, number>): number {
  let max = 0
  for (const value of pressure.values()) {
    if (value > max) max = value
  }
  return max
}

function extendedRunLength(board: SearchBoard, player: Player, cells: string[], directionIndex: number): number {
  const [dq, dr] = WIN_DIRECTIONS[directionIndex]
  const occupied = cells.map((cellKey) => board.moves.get(cellKey) === player)
  let best = 0
  let index = 0

  while (index < occupied.length) {
    if (!occupied[index]) {
      index += 1
      continue
    }

    const runStart = index
    while (index + 1 < occupied.length && occupied[index + 1]) index += 1
    const runEnd = index

    let length = runEnd - runStart + 1
    const [startQ, startR] = cells[runStart].split(',').map(Number)
    const [endQ, endR] = cells[runEnd].split(',').map(Number)

    let prevQ = startQ - dq
    let prevR = startR - dr
    while (board.moves.get(`${prevQ},${prevR}`) === player) {
      length += 1
      prevQ -= dq
      prevR -= dr
    }

    let nextQ = endQ + dq
    let nextR = endR + dr
    while (board.moves.get(`${nextQ},${nextR}`) === player) {
      length += 1
      nextQ += dq
      nextR += dr
    }

    if (length > best) best = length
    index += 1
  }

  return best
}

function greedyBlockerBurden(cutSets: string[][], maxBlockers = 4): number {
  if (cutSets.length === 0) return 0
  let remaining = cutSets.map((cells) => [...cells])
  let blockers = 0

  while (remaining.length > 0 && blockers < maxBlockers) {
    const coverage = new Map<string, number>()
    for (const cells of remaining) {
      for (const cell of cells) coverage.set(cell, (coverage.get(cell) ?? 0) + 1)
    }

    let bestCell = ''
    let bestCoverage = 0
    for (const [cell, count] of coverage.entries()) {
      if (count > bestCoverage) {
        bestCoverage = count
        bestCell = cell
      }
    }

    if (bestCoverage <= 0 || bestCell.length === 0) break
    blockers += 1
    remaining = remaining.filter((cells) => !cells.includes(bestCell))
  }

  return remaining.length === 0 ? blockers : maxBlockers + 1
}

function residualWindowRatioAfterBestBlock(cutSets: string[][]): number {
  if (cutSets.length === 0) return 0
  const coverage = new Map<string, number>()
  for (const cells of cutSets) {
    for (const cell of cells) coverage.set(cell, (coverage.get(cell) ?? 0) + 1)
  }

  let bestCell = ''
  let bestCoverage = 0
  for (const [cell, count] of coverage.entries()) {
    if (count > bestCoverage) {
      bestCoverage = count
      bestCell = cell
    }
  }
  if (bestCell.length === 0) return 0

  let remaining = 0
  for (const cells of cutSets) {
    if (!cells.includes(bestCell)) remaining += 1
  }
  return remaining / cutSets.length
}

function collectThreatWindows(board: SearchBoard, player: Player): ThreatWindow[] {
  const windows: ThreatWindow[] = []

  for (const window of board.activeWindows.values()) {
    const ownCount = player === 'X' ? window.xCount : window.oCount
    const oppCount = player === 'X' ? window.oCount : window.xCount
    if (ownCount <= 0 || oppCount > 0) continue

    const threat = extendedRunLength(board, player, window.cellKeys, window.directionIndex)
    if (threat < 2 || threat >= WIN_LENGTH) continue

    const cutSet: string[] = []
    for (const cellKey of window.cellKeys) {
      if (!board.moves.has(cellKey)) cutSet.push(cellKey)
    }
    if (cutSet.length === 0) continue

    windows.push({ threat, directionIndex: window.directionIndex, cutSet })
  }

  return windows
}

function pressureForThreatLevel(windows: ThreatWindow[], threat: number, tuning: BotTuning): ThreatLevelStats {
  const levelWindows = windows.filter((window) => window.threat === threat)
  if (levelWindows.length === 0) {
    return {
      windowCount: 0,
      blockerBurden: 0,
      resilience: 0,
      directionCount: 0,
      pressure: 0,
    }
  }

  const cutSets = levelWindows.map((window) => window.cutSet)
  const windowCount = levelWindows.length
  const blockerBurden = greedyBlockerBurden(cutSets)
  const resilience = residualWindowRatioAfterBestBlock(cutSets)
  const directionCount = new Set(levelWindows.map((window) => window.directionIndex)).size
  const weight = tuning.threatWeights[threat] ?? 0
  const pressure = weight * windowCount * windowCount * Math.max(1, blockerBurden) * (0.5 + 0.5 * resilience)

  return {
    windowCount,
    blockerBurden,
    resilience,
    directionCount,
    pressure,
  }
}

function collectThreatProfile(board: SearchBoard, player: Player, tuning: BotTuning): ThreatProfile {
  const windows = collectThreatWindows(board, player)
  const levels = Array.from({ length: WIN_LENGTH + 1 }, (_, threat) => pressureForThreatLevel(windows, threat, tuning))
  let totalPressure = 0
  for (let threat = 2; threat <= 5; threat += 1) totalPressure += levels[threat].pressure
  return { levels, totalPressure }
}

function analyzeBoard(board: SearchBoard, tuning: BotTuning) {
  const xOneTurnWins = board.xOneTurnThreatGroupCounts.size
  const oOneTurnWins = board.oOneTurnThreatGroupCounts.size
  const xStones = countStones(board, 'X')
  const oStones = countStones(board, 'O')
  const xProfile = collectThreatProfile(board, 'X', tuning)
  const oProfile = collectThreatProfile(board, 'O', tuning)

  const scale = Math.max(1, tuning.threatSeverityScale)
  const xRaw = applyTempoDiscount(xProfile.totalPressure, xStones, oStones, tuning)
  const oRaw = applyTempoDiscount(oProfile.totalPressure, oStones, xStones, tuning)
  const xScore = xRaw / (xRaw + scale)
  const oScore = oRaw / (oRaw + scale)
  const total = xScore + oScore

  const xThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const oThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  for (let threat = 2; threat <= 5; threat += 1) {
    xThreats[threat] = xProfile.levels[threat].windowCount
    oThreats[threat] = oProfile.levels[threat].windowCount
  }

  return {
    xOneTurnWins,
    oOneTurnWins,
    xWillWinNextTurn: xOneTurnWins > 0,
    oWillWinNextTurn: oOneTurnWins > 0,
    xThreats,
    oThreats,
    xOffense: xProfile.totalPressure,
    oOffense: oProfile.totalPressure,
    xDiversity: xProfile.totalPressure,
    oDiversity: oProfile.totalPressure,
    xBreadthSeverity: xProfile.totalPressure,
    oBreadthSeverity: oProfile.totalPressure,
    xThreat3Breadth: xProfile.levels[3].windowCount,
    oThreat3Breadth: oProfile.levels[3].windowCount,
    xThreat3DirectionCount: xProfile.levels[3].directionCount,
    oThreat3DirectionCount: oProfile.levels[3].directionCount,
    xThreat3BlockerBurden: xProfile.levels[3].blockerBurden,
    oThreat3BlockerBurden: oProfile.levels[3].blockerBurden,
    xTriangleCount: 0,
    oTriangleCount: 0,
    xRhombusCount: 0,
    oRhombusCount: 0,
    xThreat3StructureSeverity: xProfile.levels[3].pressure,
    oThreat3StructureSeverity: oProfile.levels[3].pressure,
    xThreat3BaseSeverity: xProfile.levels[3].pressure,
    oThreat3BaseSeverity: oProfile.levels[3].pressure,
    xThreat3BreadthSeverity: xProfile.levels[3].pressure,
    oThreat3BreadthSeverity: oProfile.levels[3].pressure,
    xUrgencyLoad: xProfile.levels[4].blockerBurden + xProfile.levels[5].blockerBurden,
    oUrgencyLoad: oProfile.levels[4].blockerBurden + oProfile.levels[5].blockerBurden,
    xUrgencyPressure: xProfile.levels[4].resilience,
    oUrgencyPressure: oProfile.levels[4].resilience,
    xUrgencyDiscount: 1,
    oUrgencyDiscount: 1,
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
    xThreats: [...analysis.xThreats],
    oThreats: [...analysis.oThreats],
    xOffense: analysis.xOffense,
    oOffense: analysis.oOffense,
    xDiversity: analysis.xDiversity,
    oDiversity: analysis.oDiversity,
    xBreadthSeverity: analysis.xBreadthSeverity,
    oBreadthSeverity: analysis.oBreadthSeverity,
    xThreat3Breadth: analysis.xThreat3Breadth,
    oThreat3Breadth: analysis.oThreat3Breadth,
    xThreat3DirectionCount: analysis.xThreat3DirectionCount,
    oThreat3DirectionCount: analysis.oThreat3DirectionCount,
    xThreat3BlockerBurden: analysis.xThreat3BlockerBurden,
    oThreat3BlockerBurden: analysis.oThreat3BlockerBurden,
    xTriangleCount: analysis.xTriangleCount,
    oTriangleCount: analysis.oTriangleCount,
    xRhombusCount: analysis.xRhombusCount,
    oRhombusCount: analysis.oRhombusCount,
    xThreat3StructureSeverity: analysis.xThreat3StructureSeverity,
    oThreat3StructureSeverity: analysis.oThreat3StructureSeverity,
    xThreat3BaseSeverity: analysis.xThreat3BaseSeverity,
    oThreat3BaseSeverity: analysis.oThreat3BaseSeverity,
    xThreat3BreadthSeverity: analysis.xThreat3BreadthSeverity,
    oThreat3BreadthSeverity: analysis.oThreat3BreadthSeverity,
    xUrgencyLoad: analysis.xUrgencyLoad,
    oUrgencyLoad: analysis.oUrgencyLoad,
    xUrgencyPressure: analysis.xUrgencyPressure,
    oUrgencyPressure: analysis.oUrgencyPressure,
    xUrgencyDiscount: analysis.xUrgencyDiscount,
    oUrgencyDiscount: analysis.oUrgencyDiscount,
    xPressureMap: new Map(board.xPressureMap),
    oPressureMap: new Map(board.oPressureMap),
    xPressureMax: pressureMax(board.xPressureMap),
    oPressureMax: pressureMax(board.oPressureMap),
  }
}
