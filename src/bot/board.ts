import type { Axial, LiveLikeState, MoveRecord, Player } from './types.ts'
import { WIN_DIRECTIONS, WIN_LENGTH } from './types.ts'

const HASH_MASK = (1n << 64n) - 1n

export type ActiveWindow = {
  key: string
  directionIndex: number
  startQ: number
  startR: number
  cellKeys: string[]
  xCount: number
  oCount: number
}

export type SearchBoard = {
  moves: Map<string, Player>
  moveHistory: MoveRecord[]
  turn: Player
  placementsLeft: number
  hash: bigint
  activeWindows: Map<string, ActiveWindow>
}

export type BoardMoveUndo = {
  key: string
  q: number
  r: number
  mark: Player
  prevTurn: Player
  prevPlacementsLeft: number
  prevHash: bigint
  prevHistoryLength: number
  winner: Player | null
}

export type AppliedBoardTurn = {
  appliedMoves: Axial[]
  undos: BoardMoveUndo[]
  winner: Player | null
}

export function toKey(q: number, r: number): string {
  return `${q},${r}`
}

export function fromKey(key: string): Axial {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
}

function zigZag(value: number): bigint {
  return value >= 0 ? BigInt(value) << 1n : (BigInt(-value) << 1n) - 1n
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & HASH_MASK
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & HASH_MASK
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & HASH_MASK
  return z ^ (z >> 31n)
}

function pieceHash(q: number, r: number, mark: Player): bigint {
  const packed = (zigZag(q) << 33n) ^ (zigZag(r) << 1n) ^ (mark === 'O' ? 1n : 0n)
  return mix64(packed)
}

function windowKey(startQ: number, startR: number, directionIndex: number): string {
  return `${directionIndex}|${startQ},${startR}`
}

function createWindow(startQ: number, startR: number, directionIndex: number): ActiveWindow {
  const [dq, dr] = WIN_DIRECTIONS[directionIndex]
  const cellKeys: string[] = []
  for (let i = 0; i < WIN_LENGTH; i += 1) {
    cellKeys.push(toKey(startQ + dq * i, startR + dr * i))
  }
  return {
    key: windowKey(startQ, startR, directionIndex),
    directionIndex,
    startQ,
    startR,
    cellKeys,
    xCount: 0,
    oCount: 0,
  }
}

function updateWindowsForPlacement(board: SearchBoard, q: number, r: number, mark: Player, delta: 1 | -1): void {
  for (let directionIndex = 0; directionIndex < WIN_DIRECTIONS.length; directionIndex += 1) {
    const [dq, dr] = WIN_DIRECTIONS[directionIndex]
    for (let offset = 0; offset < WIN_LENGTH; offset += 1) {
      const startQ = q - dq * offset
      const startR = r - dr * offset
      const key = windowKey(startQ, startR, directionIndex)
      let window = board.activeWindows.get(key)
      if (!window) {
        if (delta < 0) continue
        window = createWindow(startQ, startR, directionIndex)
        board.activeWindows.set(key, window)
      }
      if (mark === 'X') window.xCount += delta
      else window.oCount += delta
      if (window.xCount <= 0 && window.oCount <= 0) {
        board.activeWindows.delete(key)
      }
    }
  }
}

function turnStateFromMoveCount(totalMoves: number): { turn: Player; placementsLeft: number } {
  if (totalMoves === 0) {
    return { turn: 'X', placementsLeft: 1 }
  }
  if (totalMoves === 1) {
    return { turn: 'O', placementsLeft: 2 }
  }
  const k = totalMoves - 1
  const turnIndex = Math.floor(k / 2)
  return {
    turn: turnIndex % 2 === 0 ? 'O' : 'X',
    placementsLeft: k % 2 === 0 ? 2 : 1,
  }
}

function countDirectional(board: SearchBoard, q: number, r: number, dq: number, dr: number, player: Player): number {
  let count = 0
  let cq = q + dq
  let cr = r + dr
  while (board.moves.get(toKey(cq, cr)) === player) {
    count += 1
    cq += dq
    cr += dr
  }
  return count
}

export function isWinningPlacement(board: SearchBoard, q: number, r: number, player: Player): boolean {
  for (const [dq, dr] of WIN_DIRECTIONS) {
    const forward = countDirectional(board, q, r, dq, dr, player)
    const backward = countDirectional(board, q, r, -dq, -dr, player)
    if (1 + forward + backward >= WIN_LENGTH) {
      return true
    }
  }
  return false
}

export function createSearchBoard(state: LiveLikeState): SearchBoard {
  const board: SearchBoard = {
    moves: new Map(state.moves),
    moveHistory: [...state.moveHistory],
    turn: state.turn,
    placementsLeft: state.placementsLeft,
    hash: 0n,
    activeWindows: new Map(),
  }
  for (const [key, mark] of board.moves.entries()) {
    const { q, r } = fromKey(key)
    board.hash ^= pieceHash(q, r, mark)
    updateWindowsForPlacement(board, q, r, mark, 1)
  }
  return board
}

export function boardToLiveState(board: SearchBoard): LiveLikeState {
  return {
    moves: new Map(board.moves),
    moveHistory: [...board.moveHistory],
    turn: board.turn,
    placementsLeft: board.placementsLeft,
  }
}

export function boardStateKey(board: SearchBoard): string {
  return `${board.hash.toString(16)}|${board.turn}|${board.placementsLeft}`
}

export function windowEmptyCount(window: ActiveWindow): number {
  return WIN_LENGTH - window.xCount - window.oCount
}

export function windowEmpties(board: SearchBoard, window: ActiveWindow): string[] {
  const empties: string[] = []
  for (const cellKey of window.cellKeys) {
    if (!board.moves.has(cellKey)) empties.push(cellKey)
  }
  return empties
}

export function makeBoardMove(board: SearchBoard, move: Axial, mark: Player = board.turn): BoardMoveUndo | null {
  if (board.placementsLeft <= 0) return null
  const key = toKey(move.q, move.r)
  if (board.moves.has(key)) return null

  const undo: BoardMoveUndo = {
    key,
    q: move.q,
    r: move.r,
    mark,
    prevTurn: board.turn,
    prevPlacementsLeft: board.placementsLeft,
    prevHash: board.hash,
    prevHistoryLength: board.moveHistory.length,
    winner: null,
  }

  board.moves.set(key, mark)
  board.moveHistory.push({ q: move.q, r: move.r, mark })
  board.hash ^= pieceHash(move.q, move.r, mark)
  updateWindowsForPlacement(board, move.q, move.r, mark, 1)

  if (isWinningPlacement(board, move.q, move.r, mark)) {
    board.placementsLeft = 0
    undo.winner = mark
    return undo
  }

  board.placementsLeft -= 1
  if (board.placementsLeft === 0) {
    const nextTurn = turnStateFromMoveCount(board.moves.size)
    board.turn = nextTurn.turn
    board.placementsLeft = nextTurn.placementsLeft
  }
  return undo
}

export function undoBoardMove(board: SearchBoard, undo: BoardMoveUndo): void {
  board.moves.delete(undo.key)
  board.moveHistory.length = undo.prevHistoryLength
  board.hash = undo.prevHash
  board.turn = undo.prevTurn
  board.placementsLeft = undo.prevPlacementsLeft
  updateWindowsForPlacement(board, undo.q, undo.r, undo.mark, -1)
}

export function applyTurnLineToBoard(board: SearchBoard, line: Axial[]): AppliedBoardTurn {
  const undos: BoardMoveUndo[] = []
  const appliedMoves: Axial[] = []
  let winner: Player | null = null

  for (const move of line) {
    if (board.placementsLeft <= 0 || winner) break
    const undo = makeBoardMove(board, move, board.turn)
    if (!undo) continue
    undos.push(undo)
    appliedMoves.push(move)
    if (undo.winner) {
      winner = undo.winner
      break
    }
  }

  return { appliedMoves, undos, winner }
}

export function undoAppliedTurn(board: SearchBoard, applied: AppliedBoardTurn): void {
  for (let i = applied.undos.length - 1; i >= 0; i -= 1) {
    undoBoardMove(board, applied.undos[i])
  }
}
