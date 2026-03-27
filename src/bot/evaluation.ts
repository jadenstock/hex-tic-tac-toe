import type { BotTuning, EvaluationResult, Player } from './types.ts'
import { DEFAULT_BOT_TUNING, WIN_DIRECTIONS, WIN_LENGTH } from './types.ts'

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function fromKey(key: string): { q: number; r: number } {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
}

function pressureDiversity(pressure: Map<string, number>): number {
  let total = 0
  for (const v of pressure.values()) total += v
  if (total <= 0 || pressure.size <= 1) return 0

  let entropy = 0
  for (const v of pressure.values()) {
    const p = v / total
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

export function evaluateBoardState(moves: Map<string, Player>, tuning: BotTuning = DEFAULT_BOT_TUNING): EvaluationResult {
  const xThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const oThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const xOneTurnFinishRefs = new Map<string, number>()
  const oOneTurnFinishRefs = new Map<string, number>()
  const xOneTurnThreatGroups = new Set<string>()
  const oOneTurnThreatGroups = new Set<string>()
  const xPressureMap = new Map<string, number>()
  const oPressureMap = new Map<string, number>()

  if (moves.size > 0) {
    const occupied = [...moves.keys()].map(fromKey)
    let minQ = occupied[0].q
    let maxQ = occupied[0].q
    let minR = occupied[0].r
    let maxR = occupied[0].r

    for (const cell of occupied) {
      if (cell.q < minQ) minQ = cell.q
      if (cell.q > maxQ) maxQ = cell.q
      if (cell.r < minR) minR = cell.r
      if (cell.r > maxR) maxR = cell.r
    }

    const margin = WIN_LENGTH
    const qStart = minQ - margin
    const qEnd = maxQ + margin
    const rStart = minR - margin
    const rEnd = maxR + margin

    for (let q = qStart; q <= qEnd; q += 1) {
      for (let r = rStart; r <= rEnd; r += 1) {
        for (const [dq, dr] of WIN_DIRECTIONS) {
          let xCount = 0
          let oCount = 0
          const empties: string[] = []

          for (let i = 0; i < WIN_LENGTH; i += 1) {
            const cellKey = toKey(q + dq * i, r + dr * i)
            const mark = moves.get(cellKey)
            if (mark === 'X') xCount += 1
            if (mark === 'O') oCount += 1
            if (!mark) empties.push(cellKey)
            if (xCount > 0 && oCount > 0) break
          }

          if (xCount > 0 && oCount === 0) {
            xThreats[xCount] += 1
            if (xCount >= 3 && xCount <= 5 && empties.length > 0) {
              const mass = threatPressureMass(xCount)
              const share = mass / empties.length
              for (const cell of empties) {
                xPressureMap.set(cell, (xPressureMap.get(cell) ?? 0) + share)
              }
            }
            if (xCount >= 4 && empties.length <= 2) {
              const groupKey = empties.slice().sort().join('|')
              xOneTurnThreatGroups.add(groupKey)
              for (const cell of empties) {
                xOneTurnFinishRefs.set(cell, (xOneTurnFinishRefs.get(cell) ?? 0) + 1)
              }
            }
          } else if (oCount > 0 && xCount === 0) {
            oThreats[oCount] += 1
            if (oCount >= 3 && oCount <= 5 && empties.length > 0) {
              const mass = threatPressureMass(oCount)
              const share = mass / empties.length
              for (const cell of empties) {
                oPressureMap.set(cell, (oPressureMap.get(cell) ?? 0) + share)
              }
            }
            if (oCount >= 4 && empties.length <= 2) {
              const groupKey = empties.slice().sort().join('|')
              oOneTurnThreatGroups.add(groupKey)
              for (const cell of empties) {
                oOneTurnFinishRefs.set(cell, (oOneTurnFinishRefs.get(cell) ?? 0) + 1)
              }
            }
          }
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
  const xRawScore = xOffense
  const oRawScore = oOffense
  const xScore = Math.max(0, xRawScore)
  const oScore = Math.max(0, oRawScore)
  const total = xScore + oScore
  const xShare = total > 0 ? xScore / total : 0.5
  let xPressureMax = 0
  for (const v of xPressureMap.values()) {
    if (v > xPressureMax) xPressureMax = v
  }
  let oPressureMax = 0
  for (const v of oPressureMap.values()) {
    if (v > oPressureMax) oPressureMax = v
  }

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
