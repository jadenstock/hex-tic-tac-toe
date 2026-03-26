import { performance } from 'node:perf_hooks'
import { chooseGreedyTurn, type LiveLikeState, type Player } from '../../src/bot/engine.ts'
import type { Entrant, MatchOutcome } from './types.ts'

const WIN_LENGTH = 6
const WIN_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, -1],
]

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function countDirectional(board: Map<string, Player>, q: number, r: number, dq: number, dr: number, player: Player): number {
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

function createInitialState(): LiveLikeState {
  return {
    moves: new Map<string, Player>(),
    moveHistory: [],
    turn: 'X',
    placementsLeft: 1,
  }
}

export function playSingleGame(x: Entrant, o: Entrant, maxPlacements: number): MatchOutcome {
  const state = createInitialState()

  let placements = 0
  let xDecisionMs = 0
  let oDecisionMs = 0
  let xTurns = 0
  let oTurns = 0
  let xPlacements = 0
  let oPlacements = 0

  while (placements < maxPlacements) {
    const isXTurn = state.turn === 'X'
    const bot = isXTurn ? x : o
    const start = performance.now()
    const planned = chooseGreedyTurn(state, bot.tuning)
    const decisionMs = performance.now() - start

    if (isXTurn) {
      xDecisionMs += decisionMs
      xTurns += 1
    } else {
      oDecisionMs += decisionMs
      oTurns += 1
    }

    if (planned.length === 0) {
      return {
        winner: 'draw',
        turns: xTurns + oTurns,
        placements,
        xDecisionMs,
        oDecisionMs,
        xTurns,
        oTurns,
        xPlacements,
        oPlacements,
        reason: 'no_candidates',
      }
    }

    let legalPlayed = 0
    for (let i = 0; i < planned.length && legalPlayed < state.placementsLeft; i += 1) {
      const move = planned[i]
      const key = toKey(move.q, move.r)
      if (state.moves.has(key)) continue

      state.moves.set(key, state.turn)
      state.moveHistory.push({ q: move.q, r: move.r, mark: state.turn })
      placements += 1
      legalPlayed += 1

      if (isXTurn) xPlacements += 1
      else oPlacements += 1

      if (isWinningPlacement(state.moves, move.q, move.r, state.turn)) {
        return {
          winner: state.turn,
          turns: xTurns + oTurns,
          placements,
          xDecisionMs,
          oDecisionMs,
          xTurns,
          oTurns,
          xPlacements,
          oPlacements,
          reason: 'win',
        }
      }

      if (placements >= maxPlacements) {
        return {
          winner: 'draw',
          turns: xTurns + oTurns,
          placements,
          xDecisionMs,
          oDecisionMs,
          xTurns,
          oTurns,
          xPlacements,
          oPlacements,
          reason: 'max_placements',
        }
      }
    }

    if (legalPlayed === 0) {
      return {
        winner: 'draw',
        turns: xTurns + oTurns,
        placements,
        xDecisionMs,
        oDecisionMs,
        xTurns,
        oTurns,
        xPlacements,
        oPlacements,
        reason: 'illegal_only',
      }
    }

    state.turn = state.turn === 'X' ? 'O' : 'X'
    state.placementsLeft = 2
  }

  return {
    winner: 'draw',
    turns: xTurns + oTurns,
    placements,
    xDecisionMs,
    oDecisionMs,
    xTurns,
    oTurns,
    xPlacements,
    oPlacements,
    reason: 'max_placements',
  }
}
