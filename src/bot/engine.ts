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

type Axial = { q: number; r: number }

export type EvaluationResult = {
  xScore: number
  oScore: number
  xShare: number
  objectiveForX: number
  objectiveForO: number
  xThreats: number[]
  oThreats: number[]
  xOneTurnWins: number
  oOneTurnWins: number
  xWillWinNextTurn: boolean
  oWillWinNextTurn: boolean
}

const WIN_LENGTH = 6
const WIN_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, -1],
]

export type BotTuning = {
  threatWeights: number[]
  threatBreadthWeights: number[]
  defenseWeight: number
  immediateDangerPenalty: number
  oneTurnWinBonus: number
  oneTurnForkBonus: number
  oneTurnOverlapPenalty: number
  threat3ClusterBonus: number
  threat4ForkBonus: number
  threat5ForkBonus: number
  candidateRadius: number
  topKFirstMoves: number
}

export const DEFAULT_BOT_TUNING: BotTuning = {
  threatWeights: [0, 0, 1, 30.6, 760, 912, 20000],
  threatBreadthWeights: [0, 0, 0, 28.8, 180, 225, 0],
  defenseWeight: 0.72,
  immediateDangerPenalty: 412500,
  oneTurnWinBonus: 8100,
  oneTurnForkBonus: 27300,
  oneTurnOverlapPenalty: 6975,
  threat3ClusterBonus: 120,
  threat4ForkBonus: 17400,
  threat5ForkBonus: 15000,
  candidateRadius: 4,
  topKFirstMoves: 5,
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function fromKey(key: string): Axial {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
}

function scoreThreatCounts(counts: number[], tuning: BotTuning): number {
  let total = 0
  for (let i = 1; i <= WIN_LENGTH; i += 1) {
    total += tuning.threatWeights[i] * counts[i]
    total += tuning.threatBreadthWeights[i] * counts[i] * counts[i]
  }

  // Favor building a few strong concurrent threats over many weak lines.
  total += tuning.threat3ClusterBonus * counts[3] * counts[3]

  // Multiple 4/5 threats are close to forced wins with 2 placements per turn.
  const extra4 = Math.max(0, counts[4] - 1)
  const extra5 = Math.max(0, counts[5] - 1)
  total += tuning.threat4ForkBonus * extra4 * extra4
  total += tuning.threat5ForkBonus * extra5 * extra5

  return total
}

export function evaluateBoardState(moves: Map<string, Player>, tuning: BotTuning = DEFAULT_BOT_TUNING): EvaluationResult {
  const xThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const oThreats = Array<number>(WIN_LENGTH + 1).fill(0)
  const xOneTurnFinishRefs = new Map<string, number>()
  const oOneTurnFinishRefs = new Map<string, number>()
  const xOneTurnThreatGroups = new Set<string>()
  const oOneTurnThreatGroups = new Set<string>()

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
            if (xCount >= 4 && empties.length <= 2) {
              const groupKey = empties.slice().sort().join('|')
              xOneTurnThreatGroups.add(groupKey)
              for (const cell of empties) {
                xOneTurnFinishRefs.set(cell, (xOneTurnFinishRefs.get(cell) ?? 0) + 1)
              }
            }
          } else if (oCount > 0 && xCount === 0) {
            oThreats[oCount] += 1
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
  const xOverlap = [...xOneTurnFinishRefs.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const oOverlap = [...oOneTurnFinishRefs.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const xForkPressure = Math.max(0, xOneTurnWins - 1)
  const oForkPressure = Math.max(0, oOneTurnWins - 1)

  const xRawScore =
    scoreThreatCounts(xThreats, tuning) +
    xOneTurnWins * tuning.oneTurnWinBonus +
    xForkPressure * xForkPressure * tuning.oneTurnForkBonus -
    xOverlap * tuning.oneTurnOverlapPenalty
  const oRawScore =
    scoreThreatCounts(oThreats, tuning) +
    oOneTurnWins * tuning.oneTurnWinBonus +
    oForkPressure * oForkPressure * tuning.oneTurnForkBonus -
    oOverlap * tuning.oneTurnOverlapPenalty
  const xScore = Math.max(0, xRawScore)
  const oScore = Math.max(0, oRawScore)
  const total = xScore + oScore
  const xShare = total > 0 ? xScore / total : 0.5

  return {
    xScore,
    oScore,
    xShare,
    objectiveForX: xScore - oScore,
    objectiveForO: oScore - xScore,
    xThreats,
    oThreats,
    xOneTurnWins,
    oOneTurnWins,
    xWillWinNextTurn,
    oWillWinNextTurn,
  }
}

function appendMove(state: LiveLikeState, q: number, r: number, mark: Player): LiveLikeState {
  const nextMoves = new Map(state.moves)
  nextMoves.set(toKey(q, r), mark)
  return {
    ...state,
    moves: nextMoves,
    moveHistory: [...state.moveHistory, { q, r, mark }],
  }
}

function candidateCells(moves: Map<string, Player>, radius: number): Axial[] {
  if (moves.size === 0) {
    return [{ q: 0, r: 0 }]
  }

  const occupied = new Set(moves.keys())
  const candidates = new Set<string>()

  for (const key of occupied) {
    const { q, r } = fromKey(key)
    for (let dq = -radius; dq <= radius; dq += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        const ds = -dq - dr
        const distance = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds))
        if (distance > radius) continue
        const cellKey = toKey(q + dq, r + dr)
        if (!occupied.has(cellKey)) {
          candidates.add(cellKey)
        }
      }
    }
  }

  return [...candidates].map(fromKey)
}

function objectiveForPlayer(
  result: EvaluationResult,
  player: Player,
  tuning: BotTuning,
  options?: { ignoreDangerFlag?: boolean },
): number {
  const own = player === 'X' ? result.xScore : result.oScore
  const opp = player === 'X' ? result.oScore : result.xScore
  const oppOneTurnWins = player === 'X' ? result.oOneTurnWins : result.xOneTurnWins
  const dangerPenalty = options?.ignoreDangerFlag ? 0 : oppOneTurnWins > 0 ? tuning.immediateDangerPenalty : 0
  return (1 - tuning.defenseWeight) * own - tuning.defenseWeight * opp - dangerPenalty
}

function countDirectional(
  board: Map<string, Player>,
  q: number,
  r: number,
  dq: number,
  dr: number,
  player: Player,
): number {
  let count = 0
  let cq = q + dq
  let cr = r + dr
  while (board.get(toKey(cq, cr)) === player) {
    count += 1
    cq += dq
    cr += dr
  }
  return count
}

function isWinningPlacement(board: Map<string, Player>, q: number, r: number, player: Player): boolean {
  for (const [dq, dr] of WIN_DIRECTIONS) {
    const forward = countDirectional(board, q, r, dq, dr, player)
    const backward = countDirectional(board, q, r, -dq, -dr, player)
    if (1 + forward + backward >= WIN_LENGTH) {
      return true
    }
  }
  return false
}

function findImmediateWinningMove(state: LiveLikeState, player: Player, radius: number): Axial | null {
  const options = candidateCells(state.moves, radius)
  for (const option of options) {
    const simulated = appendMove(state, option.q, option.r, player)
    if (isWinningPlacement(simulated.moves, option.q, option.r, player)) {
      return option
    }
  }
  return null
}

export function chooseGreedyTurn(state: LiveLikeState, tuning: BotTuning = DEFAULT_BOT_TUNING): Axial[] {
  const player = state.turn
  const placements = state.placementsLeft
  if (placements <= 0) return []

  // Hard tactical rule: if a winning move exists right now, take it immediately.
  const immediateWin = findImmediateWinningMove(state, player, tuning.candidateRadius)
  if (immediateWin) {
    return [immediateWin]
  }

  const rankMoves = (working: LiveLikeState, rankOptions?: { ignoreDangerFlag?: boolean }) => {
    const moveOptions = candidateCells(working.moves, tuning.candidateRadius)
    const ranked = moveOptions.map((option) => {
      const simulated = appendMove(working, option.q, option.r, player)
      const immediateWin = isWinningPlacement(simulated.moves, option.q, option.r, player)
      const evalResult = evaluateBoardState(simulated.moves, tuning)
      const objective = immediateWin
        ? Number.POSITIVE_INFINITY
        : objectiveForPlayer(evalResult, player, tuning, rankOptions)
      const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore
      return { option, simulated, immediateWin, objective, ownScore }
    })

    ranked.sort((a, b) => {
      if (a.immediateWin !== b.immediateWin) return a.immediateWin ? -1 : 1
      if (a.objective !== b.objective) return b.objective - a.objective
      return b.ownScore - a.ownScore
    })

    return ranked
  }

  const firstRanked = rankMoves(state, { ignoreDangerFlag: placements >= 2 })
  if (firstRanked.length === 0) return []
  if (firstRanked[0].immediateWin || placements === 1) return [firstRanked[0].option]

  const topK = Math.max(1, Math.floor(tuning.topKFirstMoves))
  const firstCandidates = firstRanked.slice(0, topK)
  let bestLine: Axial[] = [firstCandidates[0].option]
  let bestObjective = Number.NEGATIVE_INFINITY
  let bestOwn = Number.NEGATIVE_INFINITY

  for (const first of firstCandidates) {
    const secondRanked = rankMoves(first.simulated)
    if (secondRanked.length === 0) {
      const evalResult = evaluateBoardState(first.simulated.moves, tuning)
      const objective = objectiveForPlayer(evalResult, player, tuning)
      const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore
      if (objective > bestObjective || (objective === bestObjective && ownScore > bestOwn)) {
        bestLine = [first.option]
        bestObjective = objective
        bestOwn = ownScore
      }
      continue
    }

    const second = secondRanked[0]
    if (second.immediateWin) {
      return [first.option, second.option]
    }

    const evalResult = evaluateBoardState(second.simulated.moves, tuning)
    const objective = objectiveForPlayer(evalResult, player, tuning)
    const ownScore = player === 'X' ? evalResult.xScore : evalResult.oScore

    if (objective > bestObjective || (objective === bestObjective && ownScore > bestOwn)) {
      bestLine = [first.option, second.option]
      bestObjective = objective
      bestOwn = ownScore
    }
  }

  return bestLine
}
