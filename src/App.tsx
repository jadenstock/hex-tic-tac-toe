import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import './App.css'
import {
  DEFAULT_BOT_SEARCH_OPTIONS,
  DEFAULT_BOT_TUNING,
  chooseBotTurnDetailedAsync,
  chooseBotTurnDetailed,
  evaluateBoardState,
  type BotSearchStats,
  type BotSearchOptions,
  type BotTuning,
} from './bot/engine'

type Player = 'X' | 'O'
type Mode = 'live' | 'sandbox'
type PlayAs = 'any' | Player
type PieceStyle = 'glyph' | 'fill'
type PaletteId = 'spruce' | 'sunset' | 'graphite' | 'midnight' | 'volcanic' | 'cobalt' | 'amber-night' | 'arena'
type SandboxBrush = Player | 'erase'
type PlanningDragMode = 'pan' | 'annotate'

type Camera = {
  x: number
  y: number
  zoom: number
}

type HoverHex = {
  q: number
  r: number
}

type MoveRecord = {
  q: number
  r: number
  mark: Player
  actorType?: ParticipantType
}

type ParticipantType = 'human' | 'bot'

type ParticipantInfo = {
  type: ParticipantType
  label: string
  botId?: string
  botVersion?: string
  userId?: string | null
}

type ParticipantMap = Record<Player, ParticipantInfo>

type ReplayRecord = {
  gameId: string
  roomId?: string | null
  status: string
  createdAt: number
  updatedAt: number
  startedAt?: number | null
  endedAt?: number | null
  visibility: string
  gameMode: string
  participants: ParticipantMap
  winner: Player | null
  resultType?: string | null
  moveHistory: MoveRecord[]
  finalBoard: Record<string, Player>
}

type LiveGameState = {
  moves: Map<string, Player>
  moveHistory: MoveRecord[]
  turn: Player
  placementsLeft: number
  winner: Player | null
}

type PlanningState = {
  marks: Map<string, Player>
  segments: Set<string>
}

type LiveAction =
  | {
      type: 'place'
      q: number
      r: number
    }
  | {
      type: 'sync'
      moves: Map<string, Player>
      moveHistory?: MoveRecord[]
    }
  | {
      type: 'undo'
    }
  | {
      type: 'clear'
    }

type SandboxAction =
  | {
      type: 'placeMark'
      q: number
      r: number
      mark: Player
    }
  | {
      type: 'erase'
      q: number
      r: number
    }
  | {
      type: 'undo'
    }
  | {
      type: 'clear'
    }
  | {
      type: 'load'
      state: LiveGameState
    }

type PlanningAction =
  | {
      type: 'cycleMark'
      q: number
      r: number
    }
  | {
      type: 'removeSegments'
      segmentKeys: string[]
    }
  | {
      type: 'toggleSegments'
      segmentKeys: string[]
    }
  | {
      type: 'clear'
    }

type WsStatus = 'disconnected' | 'connecting' | 'connected'

type ThemePalette = {
  dark: boolean
  ink: string
  inkSoft: string
  panel: string
  panelStrong: string
  line: string
  accent: string
  accentSoft: string
  warn: string
  pageBackground: string
  boardBackground: string
  boardGridFill: string
  boardGridStroke: string
  xColor: string
  oColor: string
  xFill: string
  oFill: string
  hoverLive: string
  hoverPlan: string
  highlightRing: string
  highlightFill: string
  deadHexFill: string
  deadHexStroke: string
  threatX4: string
  threatX5: string
  threatO4: string
  threatO5: string
  threatTextX: string
  threatTextO: string
}

const SQRT3 = Math.sqrt(3)
const BASE_HEX_SIZE = 28
const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
const WIN_LENGTH = 6
const WIN_DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, -1],
]
const THEMES: Record<PaletteId, ThemePalette> = {
  spruce: {
    dark: false,
    ink: '#1f2937',
    inkSoft: '#4b5563',
    panel: '#f2f6f4',
    panelStrong: '#e4ece8',
    line: '#b6c5bc',
    accent: '#0b6e4f',
    accentSoft: '#d8ece4',
    warn: '#b37a09',
    pageBackground: 'radial-gradient(circle at 20% 20%, #f9fdfb 0%, #edf4f0 45%, #e0e9e4 100%)',
    boardBackground: '#f5f9f7',
    boardGridFill: '#eef5f1',
    boardGridStroke: '#c8d4cd',
    xColor: '#1e2f97',
    oColor: '#8a1930',
    xFill: '#3656d4',
    oFill: '#cf4f63',
    hoverLive: '#0b6e4f',
    hoverPlan: '#6f42c1',
    highlightRing: '#b45309',
    highlightFill: 'rgba(251, 191, 36, 0.22)',
    deadHexFill: 'rgba(148, 163, 184, 0.05)',
    deadHexStroke: 'rgba(100, 116, 139, 0.16)',
    threatX4: 'rgba(30, 47, 151, 0.45)',
    threatX5: 'rgba(30, 47, 151, 0.82)',
    threatO4: 'rgba(138, 25, 48, 0.45)',
    threatO5: 'rgba(138, 25, 48, 0.82)',
    threatTextX: '#1e3a8a',
    threatTextO: '#881337',
  },
  sunset: {
    dark: false,
    ink: '#1f2937',
    inkSoft: '#4b5563',
    panel: '#faf2ec',
    panelStrong: '#f3e4d9',
    line: '#d8b9a7',
    accent: '#b45309',
    accentSoft: '#fae4cf',
    warn: '#7c2d12',
    pageBackground: 'radial-gradient(circle at 20% 20%, #fff7f1 0%, #fbe9dd 48%, #f7dcc9 100%)',
    boardBackground: '#fff5ee',
    boardGridFill: '#faede4',
    boardGridStroke: '#e1c4b2',
    xColor: '#7c2d12',
    oColor: '#0f766e',
    xFill: '#ea580c',
    oFill: '#0f766e',
    hoverLive: '#b45309',
    hoverPlan: '#9333ea',
    highlightRing: '#9a3412',
    highlightFill: 'rgba(251, 146, 60, 0.24)',
    deadHexFill: 'rgba(120, 113, 108, 0.05)',
    deadHexStroke: 'rgba(120, 53, 15, 0.17)',
    threatX4: 'rgba(124, 45, 18, 0.45)',
    threatX5: 'rgba(124, 45, 18, 0.82)',
    threatO4: 'rgba(15, 118, 110, 0.45)',
    threatO5: 'rgba(15, 118, 110, 0.82)',
    threatTextX: '#9a3412',
    threatTextO: '#0f766e',
  },
  graphite: {
    dark: false,
    ink: '#1f2937',
    inkSoft: '#475569',
    panel: '#edf1f6',
    panelStrong: '#dfe5ee',
    line: '#a6b0c0',
    accent: '#1d4ed8',
    accentSoft: '#dbe8ff',
    warn: '#92400e',
    pageBackground: 'radial-gradient(circle at 20% 20%, #f8fbff 0%, #eaf0f8 45%, #dbe3ee 100%)',
    boardBackground: '#f3f6fb',
    boardGridFill: '#e7edf7',
    boardGridStroke: '#bfcadd',
    xColor: '#1d4ed8',
    oColor: '#b91c1c',
    xFill: '#60a5fa',
    oFill: '#f87171',
    hoverLive: '#1d4ed8',
    hoverPlan: '#7c3aed',
    highlightRing: '#b45309',
    highlightFill: 'rgba(245, 158, 11, 0.2)',
    deadHexFill: 'rgba(100, 116, 139, 0.045)',
    deadHexStroke: 'rgba(51, 65, 85, 0.15)',
    threatX4: 'rgba(29, 78, 216, 0.45)',
    threatX5: 'rgba(29, 78, 216, 0.85)',
    threatO4: 'rgba(185, 28, 28, 0.45)',
    threatO5: 'rgba(185, 28, 28, 0.85)',
    threatTextX: '#1d4ed8',
    threatTextO: '#b91c1c',
  },
  midnight: {
    dark: true,
    ink: '#e6e9ef',
    inkSoft: '#b7becb',
    panel: '#182331',
    panelStrong: '#111b28',
    line: '#324357',
    accent: '#7dd3fc',
    accentSoft: '#173248',
    warn: '#f59e0b',
    pageBackground: 'radial-gradient(circle at 20% 20%, #142032 0%, #0e1726 45%, #0a111d 100%)',
    boardBackground: '#0f1827',
    boardGridFill: '#152234',
    boardGridStroke: '#2d3d55',
    xColor: '#60a5fa',
    oColor: '#fb7185',
    xFill: '#2563eb',
    oFill: '#e11d48',
    hoverLive: '#7dd3fc',
    hoverPlan: '#c084fc',
    highlightRing: '#f59e0b',
    highlightFill: 'rgba(245, 158, 11, 0.2)',
    deadHexFill: 'rgba(148, 163, 184, 0.04)',
    deadHexStroke: 'rgba(100, 116, 139, 0.12)',
    threatX4: 'rgba(96, 165, 250, 0.45)',
    threatX5: 'rgba(96, 165, 250, 0.85)',
    threatO4: 'rgba(251, 113, 133, 0.45)',
    threatO5: 'rgba(251, 113, 133, 0.85)',
    threatTextX: '#93c5fd',
    threatTextO: '#fda4af',
  },
  volcanic: {
    dark: true,
    ink: '#e9e6e2',
    inkSoft: '#c0bab3',
    panel: '#2c1a1a',
    panelStrong: '#221212',
    line: '#5b3434',
    accent: '#fb923c',
    accentSoft: '#4a281b',
    warn: '#facc15',
    pageBackground: 'radial-gradient(circle at 20% 20%, #3a1f1a 0%, #2a1515 45%, #180d0f 100%)',
    boardBackground: '#221315',
    boardGridFill: '#2f1b1d',
    boardGridStroke: '#60373a',
    xColor: '#fb923c',
    oColor: '#34d399',
    xFill: '#ea580c',
    oFill: '#059669',
    hoverLive: '#fb923c',
    hoverPlan: '#c084fc',
    highlightRing: '#facc15',
    highlightFill: 'rgba(250, 204, 21, 0.2)',
    deadHexFill: 'rgba(148, 163, 184, 0.035)',
    deadHexStroke: 'rgba(100, 116, 139, 0.11)',
    threatX4: 'rgba(251, 146, 60, 0.45)',
    threatX5: 'rgba(251, 146, 60, 0.85)',
    threatO4: 'rgba(52, 211, 153, 0.45)',
    threatO5: 'rgba(52, 211, 153, 0.85)',
    threatTextX: '#fdba74',
    threatTextO: '#6ee7b7',
  },
  cobalt: {
    dark: true,
    ink: '#e6e9ef',
    inkSoft: '#b7becb',
    panel: '#131c30',
    panelStrong: '#0d1526',
    line: '#31456c',
    accent: '#60a5fa',
    accentSoft: '#1b3050',
    warn: '#facc15',
    pageBackground: 'radial-gradient(circle at 20% 20%, #172546 0%, #0f1a33 45%, #0a1224 100%)',
    boardBackground: '#101a30',
    boardGridFill: '#162643',
    boardGridStroke: '#34507f',
    xColor: '#93c5fd',
    oColor: '#facc15',
    xFill: '#2563eb',
    oFill: '#ca8a04',
    hoverLive: '#60a5fa',
    hoverPlan: '#c084fc',
    highlightRing: '#facc15',
    highlightFill: 'rgba(250, 204, 21, 0.2)',
    deadHexFill: 'rgba(148, 163, 184, 0.035)',
    deadHexStroke: 'rgba(100, 116, 139, 0.11)',
    threatX4: 'rgba(147, 197, 253, 0.45)',
    threatX5: 'rgba(147, 197, 253, 0.85)',
    threatO4: 'rgba(250, 204, 21, 0.45)',
    threatO5: 'rgba(250, 204, 21, 0.85)',
    threatTextX: '#bfdbfe',
    threatTextO: '#fde047',
  },
  'amber-night': {
    dark: true,
    ink: '#ece8df',
    inkSoft: '#c8c1b2',
    panel: '#221b10',
    panelStrong: '#171209',
    line: '#5a4b2c',
    accent: '#facc15',
    accentSoft: '#473b1d',
    warn: '#fb923c',
    pageBackground: 'radial-gradient(circle at 20% 20%, #2f250f 0%, #1f180b 45%, #120e07 100%)',
    boardBackground: '#1b150b',
    boardGridFill: '#2a200f',
    boardGridStroke: '#625028',
    xColor: '#facc15',
    oColor: '#60a5fa',
    xFill: '#ca8a04',
    oFill: '#2563eb',
    hoverLive: '#facc15',
    hoverPlan: '#c084fc',
    highlightRing: '#60a5fa',
    highlightFill: 'rgba(96, 165, 250, 0.2)',
    deadHexFill: 'rgba(148, 163, 184, 0.03)',
    deadHexStroke: 'rgba(100, 116, 139, 0.1)',
    threatX4: 'rgba(250, 204, 21, 0.45)',
    threatX5: 'rgba(250, 204, 21, 0.85)',
    threatO4: 'rgba(96, 165, 250, 0.45)',
    threatO5: 'rgba(96, 165, 250, 0.85)',
    threatTextX: '#fde047',
    threatTextO: '#93c5fd',
  },
  arena: {
    dark: true,
    ink: '#e6edf7',
    inkSoft: '#9aa8bf',
    panel: '#18212d',
    panelStrong: '#121923',
    line: '#243243',
    accent: '#f6c542',
    accentSoft: '#40351a',
    warn: '#f59e0b',
    pageBackground: 'radial-gradient(circle at 20% 20%, #1c2531 0%, #121923 50%, #0b1017 100%)',
    boardBackground: '#111821',
    boardGridFill: '#18222e',
    boardGridStroke: '#2a394b',
    xColor: '#f6c542',
    oColor: '#8ac4ff',
    xFill: '#f6c542',
    oFill: '#8ac4ff',
    hoverLive: '#f6c542',
    hoverPlan: '#8ac4ff',
    highlightRing: '#ffffff',
    highlightFill: 'rgba(255, 255, 255, 0.08)',
    deadHexFill: 'rgba(255, 255, 255, 0.025)',
    deadHexStroke: 'rgba(255, 255, 255, 0.025)',
    threatX4: 'rgba(246, 197, 66, 0.34)',
    threatX5: 'rgba(246, 197, 66, 0.68)',
    threatO4: 'rgba(138, 196, 255, 0.34)',
    threatO5: 'rgba(138, 196, 255, 0.68)',
    threatTextX: '#f6c542',
    threatTextO: '#8ac4ff',
  },
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function fromKey(key: string): { q: number; r: number } {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
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

function findWinner(board: Map<string, Player>): Player | null {
  for (const [key, player] of board.entries()) {
    const { q, r } = fromKey(key)
    if (isWinningPlacement(board, q, r, player)) {
      return player
    }
  }

  return null
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

function deriveLiveState(moveHistory: MoveRecord[]): LiveGameState {
  const moves = new Map<string, Player>()
  for (const move of moveHistory) {
    moves.set(toKey(move.q, move.r), move.mark)
  }

  const winner = findWinner(moves)
  const turnState = turnStateFromMoveCount(moves.size)

  return {
    moves,
    moveHistory,
    turn: turnState.turn,
    placementsLeft: winner ? 0 : turnState.placementsLeft,
    winner,
  }
}

function createInitialLiveState(): LiveGameState {
  return {
    moves: new Map(),
    moveHistory: [],
    turn: 'X',
    placementsLeft: 1,
    winner: null,
  }
}

function createInitialSandboxState(): LiveGameState {
  return createInitialLiveState()
}

function createSandboxState(moveHistory: MoveRecord[]): LiveGameState {
  return deriveLiveState(moveHistory)
}

function createInitialPlanningState(): PlanningState {
  return {
    marks: new Map(),
    segments: new Set(),
  }
}

function planningSegmentKey(a: HoverHex, b: HoverHex): string {
  const first = toKey(a.q, a.r)
  const second = toKey(b.q, b.r)
  return first < second ? `${first}|${second}` : `${second}|${first}`
}

function parsePlanningSegmentKey(segmentKey: string): { start: HoverHex; end: HoverHex } | null {
  const [startKey, endKey] = segmentKey.split('|')
  if (!startKey || !endKey) return null
  return {
    start: fromKey(startKey),
    end: fromKey(endKey),
  }
}

function normalizeSegmentDirection(a: HoverHex, b: HoverHex): string {
  const dq = b.q - a.q
  const dr = b.r - a.r
  if (dq === 0 && dr === 0) return '0,0'
  if (dq < 0 || (dq === 0 && dr < 0)) {
    return `${-dq},${-dr}`
  }
  return `${dq},${dr}`
}

function collectPlanningLineSegmentKeys(segments: Set<string>, seedSegmentKey: string): string[] {
  if (!segments.has(seedSegmentKey)) return []

  const parsedSeed = parsePlanningSegmentKey(seedSegmentKey)
  if (!parsedSeed) return []

  const direction = normalizeSegmentDirection(parsedSeed.start, parsedSeed.end)
  const endpointMap = new Map<string, string[]>()

  for (const segmentKey of segments) {
    const parsed = parsePlanningSegmentKey(segmentKey)
    if (!parsed) continue
    if (normalizeSegmentDirection(parsed.start, parsed.end) !== direction) continue

    const startKey = toKey(parsed.start.q, parsed.start.r)
    const endKey = toKey(parsed.end.q, parsed.end.r)
    const startSegments = endpointMap.get(startKey) ?? []
    startSegments.push(segmentKey)
    endpointMap.set(startKey, startSegments)
    const endSegments = endpointMap.get(endKey) ?? []
    endSegments.push(segmentKey)
    endpointMap.set(endKey, endSegments)
  }

  const queue = [seedSegmentKey]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const segmentKey = queue.pop()
    if (!segmentKey || visited.has(segmentKey)) continue
    visited.add(segmentKey)

    const parsed = parsePlanningSegmentKey(segmentKey)
    if (!parsed) continue

    for (const endpoint of [parsed.start, parsed.end]) {
      const adjacent = endpointMap.get(toKey(endpoint.q, endpoint.r)) ?? []
      for (const adjacentSegment of adjacent) {
        if (!visited.has(adjacentSegment)) {
          queue.push(adjacentSegment)
        }
      }
    }
  }

  return [...visited]
}

function planningReducer(state: PlanningState, action: PlanningAction): PlanningState {
  if (action.type === 'clear') {
    return createInitialPlanningState()
  }

  if (action.type === 'removeSegments') {
    if (action.segmentKeys.length === 0) return state
    const segments = new Set(state.segments)
    let changed = false
    for (const segmentKey of action.segmentKeys) {
      if (!segments.has(segmentKey)) continue
      segments.delete(segmentKey)
      changed = true
    }
    if (!changed) return state
    return { ...state, segments }
  }

  if (action.type === 'toggleSegments') {
    if (action.segmentKeys.length === 0) return state
    const segments = new Set(state.segments)
    for (const segmentKey of action.segmentKeys) {
      if (segments.has(segmentKey)) {
        segments.delete(segmentKey)
      } else {
        segments.add(segmentKey)
      }
    }
    return { ...state, segments }
  }

  const key = toKey(action.q, action.r)
  const current = state.marks.get(key)
  const marks = new Map(state.marks)
  if (current === 'X') {
    marks.set(key, 'O')
  } else if (current === 'O') {
    marks.delete(key)
  } else {
    marks.set(key, 'X')
  }

  return { ...state, marks }
}

function sandboxReducer(state: LiveGameState, action: SandboxAction): LiveGameState {
  if (action.type === 'clear') {
    return createInitialSandboxState()
  }

  if (action.type === 'load') {
    return createSandboxState(action.state.moveHistory)
  }

  if (action.type === 'undo') {
    if (state.moveHistory.length === 0) return state
    return createSandboxState(state.moveHistory.slice(0, -1))
  }

  const key = toKey(action.q, action.r)
  if (action.type === 'erase') {
    if (!state.moves.has(key)) return state
    return createSandboxState(state.moveHistory.filter((move) => toKey(move.q, move.r) !== key))
  }

  const nextHistory = state.moveHistory.filter((move) => toKey(move.q, move.r) !== key)
  nextHistory.push({ q: action.q, r: action.r, mark: action.mark, actorType: 'human' })
  return createSandboxState(nextHistory)
}

function liveReducer(state: LiveGameState, action: LiveAction): LiveGameState {
  if (action.type === 'clear') {
    return createInitialLiveState()
  }

  if (action.type === 'sync') {
    if (action.moveHistory) {
      return deriveLiveState(action.moveHistory)
    }

    const fallbackHistory: MoveRecord[] = []
    for (const [key, mark] of action.moves.entries()) {
      const { q, r } = fromKey(key)
      fallbackHistory.push({ q, r, mark })
    }
    return deriveLiveState(fallbackHistory)
  }

  if (action.type === 'undo') {
    if (state.moveHistory.length === 0) return state
    return deriveLiveState(state.moveHistory.slice(0, -1))
  }

  if (state.winner) return state

  const key = toKey(action.q, action.r)
  if (state.moves.has(key)) return state

  const nextHistory = [...state.moveHistory, { q: action.q, r: action.r, mark: state.turn }]
  return deriveLiveState(nextHistory)
}

function axialToWorld(q: number, r: number, size: number): { x: number; y: number } {
  return {
    x: size * SQRT3 * (q + r / 2),
    y: size * 1.5 * r,
  }
}

function worldToAxial(x: number, y: number, size: number): { q: number; r: number } {
  return {
    q: (SQRT3 / 3 * x - (1 / 3) * y) / size,
    r: ((2 / 3) * y) / size,
  }
}

function roundAxial(q: number, r: number): { q: number; r: number } {
  const x = q
  const z = r
  const y = -x - z

  let rx = Math.round(x)
  let ry = Math.round(y)
  let rz = Math.round(z)

  const xDiff = Math.abs(rx - x)
  const yDiff = Math.abs(ry - y)
  const zDiff = Math.abs(rz - z)

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz
  } else if (yDiff > zDiff) {
    ry = -rx - rz
  } else {
    rz = -rx - ry
  }

  return { q: rx, r: rz }
}

function axialDistance(a: HoverHex, b: HoverHex): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  const ds = -a.q - a.r - (-b.q - b.r)
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds))
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t
}

function hexLinePath(a: HoverHex, b: HoverHex): HoverHex[] {
  const distance = axialDistance(a, b)
  if (distance === 0) return [a]

  const result: HoverHex[] = []
  for (let step = 0; step <= distance; step += 1) {
    const t = step / distance
    const point = roundAxial(lerp(a.q, b.q, t), lerp(a.r, b.r, t))
    const last = result[result.length - 1]
    if (!last || last.q !== point.q || last.r !== point.r) {
      result.push(point)
    }
  }

  return result
}

function planningPathSegmentKeys(a: HoverHex, b: HoverHex): string[] {
  const path = hexLinePath(a, b)
  const segmentKeys: string[] = []
  for (let index = 1; index < path.length; index += 1) {
    segmentKeys.push(planningSegmentKey(path[index - 1], path[index]))
  }
  return segmentKeys
}

function snapHexToPlanningAxis(anchor: HoverHex, target: HoverHex): HoverHex {
  const dq = target.q - anchor.q
  const dr = target.r - anchor.r
  const diagonalStep = Math.round((dq - dr) / 2)
  const candidates: HoverHex[] = [
    { q: target.q, r: anchor.r },
    { q: anchor.q, r: target.r },
    { q: anchor.q + diagonalStep, r: anchor.r - diagonalStep },
  ]

  let best = candidates[0]
  let bestDistance = axialDistance(best, target)

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const distance = axialDistance(candidate, target)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  return best
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay)
  }

  const t = clampValue(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1)
  const cx = ax + dx * t
  const cy = ay + dy * t
  return Math.hypot(px - cx, py - cy)
}

function boardObjectToMap(value: unknown): Map<string, Player> {
  if (!value || typeof value !== 'object') {
    return new Map()
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const next = new Map<string, Player>()

  for (const [key, marker] of entries) {
    if (marker === 'X' || marker === 'O') {
      next.set(key, marker)
    }
  }

  return next
}

function moveHistoryObjectToArray(value: unknown): MoveRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  const next: MoveRecord[] = []
  for (const move of value) {
    if (!move || typeof move !== 'object') continue
    const raw = move as Record<string, unknown>
    const mark = raw.mark
    const q = Number(raw.q)
    const r = Number(raw.r)
    const actorType = raw.actorType === 'human' || raw.actorType === 'bot' ? raw.actorType : undefined

    if ((mark === 'X' || mark === 'O') && Number.isInteger(q) && Number.isInteger(r)) {
      next.push({ q, r, mark, actorType })
    }
  }

  return next
}

function parseReplayGameId(pathname: string): string | null {
  const match = pathname.match(/^\/games\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function buildParticipants(autoBotEnabled: boolean, autoBotSide: 'X' | 'O' | 'both', joinedRoom: string | null): ParticipantMap {
  const buildParticipant = (mark: Player): ParticipantInfo => {
    const isBot = autoBotEnabled && (autoBotSide === 'both' || autoBotSide === mark)
    if (isBot) {
      return {
        type: 'bot',
        label: 'Hex Bot',
        botId: 'local-engine',
      }
    }

    return {
      type: 'human',
      label: joinedRoom ? `Player ${mark}` : `Local ${mark}`,
    }
  }

  return {
    X: buildParticipant('X'),
    O: buildParticipant('O'),
  }
}

function participantSummary(participants: ParticipantMap | null): string | null {
  if (!participants) return null
  const x = participants.X.type === 'bot' ? 'Bot' : 'Human'
  const o = participants.O.type === 'bot' ? 'Bot' : 'Human'
  return `${x} vs ${o}`
}

function isDarkPalette(paletteId: PaletteId): boolean {
  return THEMES[paletteId].dark
}

function canBelongToPlayerWinningSix(board: Map<string, Player>, q: number, r: number, player: Player): boolean {
  const opponent: Player = player === 'X' ? 'O' : 'X'
  if (board.get(toKey(q, r)) === opponent) {
    return false
  }

  for (const [dq, dr] of WIN_DIRECTIONS) {
    for (let offset = -5; offset <= 0; offset += 1) {
      let blocked = false
      for (let i = 0; i < WIN_LENGTH; i += 1) {
        const key = toKey(q + dq * (offset + i), r + dr * (offset + i))
        if (board.get(key) === opponent) {
          blocked = true
          break
        }
      }

      if (!blocked) {
        return true
      }
    }
  }

  return false
}

function isDeadHex(board: Map<string, Player>, q: number, r: number): boolean {
  return !canBelongToPlayerWinningSix(board, q, r, 'X') && !canBelongToPlayerWinningSix(board, q, r, 'O')
}

function collectThreatTargets(board: Map<string, Player>): {
  x4: Set<string>
  x5: Set<string>
  o4: Set<string>
  o5: Set<string>
} {
  const x4 = new Set<string>()
  const x5 = new Set<string>()
  const o4 = new Set<string>()
  const o5 = new Set<string>()

  if (board.size === 0) {
    return { x4, x5, o4, o5 }
  }

  const occupied = [...board.keys()].map(fromKey)
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
  for (let q = minQ - margin; q <= maxQ + margin; q += 1) {
    for (let r = minR - margin; r <= maxR + margin; r += 1) {
      for (const [dq, dr] of WIN_DIRECTIONS) {
        let xCount = 0
        let oCount = 0
        const empties: string[] = []
        for (let i = 0; i < WIN_LENGTH; i += 1) {
          const key = toKey(q + dq * i, r + dr * i)
          const mark = board.get(key)
          if (mark === 'X') xCount += 1
          if (mark === 'O') oCount += 1
          if (!mark) empties.push(key)
          if (xCount > 0 && oCount > 0) break
        }

        if (xCount === 5 && oCount === 0 && empties.length === 1) x5.add(empties[0])
        if (xCount === 4 && oCount === 0 && empties.length === 2) {
          x4.add(empties[0])
          x4.add(empties[1])
        }
        if (oCount === 5 && xCount === 0 && empties.length === 1) o5.add(empties[0])
        if (oCount === 4 && xCount === 0 && empties.length === 2) {
          o4.add(empties[0])
          o4.add(empties[1])
        }
      }
    }
  }

  return { x4, x5, o4, o5 }
}

function HintPill({ text }: { text: string }) {
  return (
    <span className="hint-pill" data-tip={text} tabIndex={0} aria-label={text}>
      ?
    </span>
  )
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function App() {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const initializedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  const [size, setSize] = useState({ width: 0, height: 0 })
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [hoverHex, setHoverHex] = useState<HoverHex | null>(null)
  const [mode, setMode] = useState<Mode>('live')
  const [playAs, setPlayAs] = useState<PlayAs>('any')

  const [liveState, dispatchLive] = useReducer(liveReducer, undefined, createInitialLiveState)
  const [sandboxState, dispatchSandbox] = useReducer(sandboxReducer, undefined, createInitialSandboxState)
  const [planningState, dispatchPlanning] = useReducer(planningReducer, undefined, createInitialPlanningState)
  const [planningPreviewSegments, setPlanningPreviewSegments] = useState<string[]>([])
  const [sandboxBrush, setSandboxBrush] = useState<SandboxBrush>('X')

  const [gameCodeInput, setGameCodeInput] = useState('')
  const [joinedRoom, setJoinedRoom] = useState<string | null>(null)
  const [trackedGameId, setTrackedGameId] = useState<string | null>(null)
  const [trackedParticipants, setTrackedParticipants] = useState<ParticipantMap | null>(null)
  const [trackedGameNotice, setTrackedGameNotice] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected')
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [showMoveNumbers, setShowMoveNumbers] = useState(false)
  const [pieceStyle, setPieceStyle] = useState<PieceStyle>('glyph')
  const [paletteId, setPaletteId] = useState<PaletteId>(() => {
    if (typeof window === 'undefined') return 'spruce'
    const hour = new Date().getHours()
    return hour >= 19 || hour < 7 ? 'midnight' : 'spruce'
  })
  const [hideDeadHexes, setHideDeadHexes] = useState(false)
  const [showThreatHighlights, setShowThreatHighlights] = useState(false)
  const [showPressureMap, setShowPressureMap] = useState(false)
  const [autoBotEnabled, setAutoBotEnabled] = useState(false)
  const [autoBotSide, setAutoBotSide] = useState<'X' | 'O' | 'both'>('both')
  const [botThinkSeconds, setBotThinkSeconds] = useState(2)
  const [botTuning, setBotTuning] = useState<BotTuning>(DEFAULT_BOT_TUNING)
  const [isBotThinking, setIsBotThinking] = useState(false)
  const [liveBotNodes, setLiveBotNodes] = useState(0)
  const [liveBotPlayouts, setLiveBotPlayouts] = useState(0)
  const [liveBotBoardEvals, setLiveBotBoardEvals] = useState(0)
  const [liveBotElapsedMs, setLiveBotElapsedMs] = useState(0)
  const [lastBotStats, setLastBotStats] = useState<BotSearchStats | null>(null)
  const [showRulesModal, setShowRulesModal] = useState(false)
  const [dockOpen, setDockOpen] = useState(true)
  const [replayRecord, setReplayRecord] = useState<ReplayRecord | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [replayStep, setReplayStep] = useState(0)
  const [isReplayLoading, setIsReplayLoading] = useState(false)

  const dragRef = useRef<{
    pointerId: number
    mode: PlanningDragMode
    lastX: number
    lastY: number
    started: boolean
    anchorHex: HoverHex | null
  } | null>(null)
  const lastAutoBotSignatureRef = useRef('')
  const lastLightPaletteRef = useRef<PaletteId>(isDarkPalette(paletteId) ? 'spruce' : paletteId)
  const lastDarkPaletteRef = useRef<PaletteId>(isDarkPalette(paletteId) ? paletteId : 'midnight')

  const wsUrl = import.meta.env.VITE_WS_URL as string | undefined
  const apiBaseUrl = import.meta.env.DEV
    ? '/api'
    : ((import.meta.env.VITE_API_URL as string | undefined) ?? '/api')
  const replayGameId = typeof window === 'undefined' ? null : parseReplayGameId(window.location.pathname)
  const isReplayMode = replayGameId !== null

  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  useEffect(() => {
    if (!isReplayMode || !replayGameId) return

    let cancelled = false
    setIsReplayLoading(true)
    setReplayError(null)

    void fetch(`${apiBaseUrl}/games/${encodeURIComponent(replayGameId)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'Tracked game not found.' : 'Failed to load tracked game.')
        }

        const payload = (await response.json()) as ReplayRecord
        if (cancelled) return

        setReplayRecord({
          ...payload,
          moveHistory: moveHistoryObjectToArray(payload.moveHistory),
          participants: payload.participants,
          winner: payload.winner === 'X' || payload.winner === 'O' ? payload.winner : null,
        })
        setReplayStep(moveHistoryObjectToArray(payload.moveHistory).length)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setReplayError(error instanceof Error ? error.message : 'Failed to load tracked game.')
      })
      .finally(() => {
        if (!cancelled) {
          setIsReplayLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, isReplayMode, replayGameId])

  useEffect(() => {
    if (!replayRecord) return

    const clampedStep = clampValue(replayStep, 0, replayRecord.moveHistory.length)
    dispatchLive({
      type: 'sync',
      moves: new Map(),
      moveHistory: replayRecord.moveHistory.slice(0, clampedStep),
    })
  }, [replayRecord, replayStep])

  useEffect(() => {
    if (isDarkPalette(paletteId)) {
      lastDarkPaletteRef.current = paletteId
      return
    }

    lastLightPaletteRef.current = paletteId
  }, [paletteId])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const { width, height } = entry.contentRect
      setSize({ width, height })

      if (!initializedRef.current && width > 0 && height > 0) {
        setCamera({ x: width / 2, y: height / 2, zoom: 1 })
        initializedRef.current = true
      }
    })

    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  const screenToWorld = useCallback(
    (screenX: number, screenY: number) => {
      return {
        x: (screenX - camera.x) / camera.zoom,
        y: (screenY - camera.y) / camera.zoom,
      }
    },
    [camera.x, camera.y, camera.zoom],
  )

  const worldToScreen = useCallback(
    (worldX: number, worldY: number) => {
      return {
        x: camera.x + worldX * camera.zoom,
        y: camera.y + worldY * camera.zoom,
      }
    },
    [camera.x, camera.y, camera.zoom],
  )

  const getHexAtScreen = useCallback(
    (screenX: number, screenY: number): HoverHex => {
      const world = screenToWorld(screenX, screenY)
      const axial = worldToAxial(world.x, world.y, BASE_HEX_SIZE)
      return roundAxial(axial.q, axial.r)
    },
    [screenToWorld],
  )

  const displayState = isReplayMode ? liveState : mode === 'sandbox' ? sandboxState : liveState
  const totalLiveMoves = liveState.moves.size
  const totalSandboxMoves = sandboxState.moves.size
  const autoBotForX = autoBotEnabled && (autoBotSide === 'X' || autoBotSide === 'both')
  const autoBotForO = autoBotEnabled && (autoBotSide === 'O' || autoBotSide === 'both')
  const showConnectedStatus = joinedRoom !== null && wsStatus === 'connected'
  const canUndo = isReplayMode ? false : mode === 'sandbox' ? sandboxState.moveHistory.length > 0 : liveState.moveHistory.length > 0
  const highlightedKeys = useMemo(() => {
    if (displayState.moveHistory.length === 0) {
      return new Set<string>()
    }

    const next = new Set<string>()
    const lastMark = displayState.moveHistory[displayState.moveHistory.length - 1].mark

    for (let i = displayState.moveHistory.length - 1; i >= 0; i -= 1) {
      const move = displayState.moveHistory[i]
      if (move.mark !== lastMark) break
      next.add(toKey(move.q, move.r))
      if (next.size >= 2) break
    }

    return next
  }, [displayState.moveHistory])
  const moveNumberByKey = useMemo(() => {
    const next = new Map<string, number>()
    for (let idx = 0; idx < displayState.moveHistory.length; idx += 1) {
      const move = displayState.moveHistory[idx]
      const moveNumber = idx === 0 ? 1 : Math.floor((idx - 1) / 4) + 2
      next.set(toKey(move.q, move.r), moveNumber)
    }
    return next
  }, [displayState.moveHistory])
  const theme = THEMES[paletteId]
  const appThemeVars = useMemo<CSSProperties>(() => {
    return {
      '--ink': theme.ink,
      '--ink-soft': theme.inkSoft,
      '--panel': theme.panel,
      '--panel-strong': theme.panelStrong,
      '--line': theme.line,
      '--accent': theme.accent,
      '--accent-soft': theme.accentSoft,
      '--warn': theme.warn,
      '--page-background': theme.pageBackground,
      '--threat-x-text': theme.threatTextX,
      '--threat-o-text': theme.threatTextO,
    } as CSSProperties
  }, [theme])

  const modeLabel = useMemo(() => {
    return mode === 'live' ? 'Game' : 'Sandbox'
  }, [mode])
  const currentParticipants = useMemo(() => {
    if (replayRecord) return replayRecord.participants
    if (trackedParticipants) return trackedParticipants
    return buildParticipants(autoBotEnabled, autoBotSide, joinedRoom)
  }, [autoBotEnabled, autoBotSide, joinedRoom, replayRecord, trackedParticipants])
  const participantModeLabel = useMemo(() => participantSummary(currentParticipants), [currentParticipants])
  const currentGameId = replayRecord?.gameId ?? trackedGameId
  const trackedGameUrl = useMemo(() => {
    if (!currentGameId || typeof window === 'undefined') return null
    return `${window.location.origin}/games/${currentGameId}`
  }, [currentGameId])
  const hasPlanningAnnotations = planningState.marks.size > 0 || planningState.segments.size > 0
  const liveEvaluation = useMemo(() => evaluateBoardState(displayState.moves, botTuning), [botTuning, displayState.moves])
  const threatTargets = useMemo(() => collectThreatTargets(displayState.moves), [displayState.moves])
  const planningSegmentAtScreen = useCallback(
    (screenX: number, screenY: number) => {
      let closestSegment: string | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      const hitThreshold = Math.max(8, BASE_HEX_SIZE * camera.zoom * 0.18)

      for (const segmentKey of planningState.segments) {
        const [startKey, endKey] = segmentKey.split('|')
        if (!startKey || !endKey) continue

        const start = fromKey(startKey)
        const end = fromKey(endKey)
        const startWorld = axialToWorld(start.q, start.r, BASE_HEX_SIZE)
        const endWorld = axialToWorld(end.q, end.r, BASE_HEX_SIZE)
        const startScreen = worldToScreen(startWorld.x, startWorld.y)
        const endScreen = worldToScreen(endWorld.x, endWorld.y)
        const distance = distanceToSegment(screenX, screenY, startScreen.x, startScreen.y, endScreen.x, endScreen.y)
        if (distance <= hitThreshold && distance < closestDistance) {
          closestDistance = distance
          closestSegment = segmentKey
        }
      }

      return closestSegment
    },
    [camera.zoom, planningState.segments, worldToScreen],
  )
  const hoverTrainingLabel = useMemo(() => {
    if (!hoverHex || (!hideDeadHexes && !showThreatHighlights)) return null

    const key = toKey(hoverHex.q, hoverHex.r)
    const tags: string[] = []
    const dead = isDeadHex(displayState.moves, hoverHex.q, hoverHex.r)
    if (hideDeadHexes && dead) tags.push('dead hex')
    if (showThreatHighlights) {
      if (threatTargets.x5.has(key)) tags.push('X 5-threat finisher')
      else if (threatTargets.x4.has(key)) tags.push('X 4-threat finisher')
      if (threatTargets.o5.has(key)) tags.push('O 5-threat finisher')
      else if (threatTargets.o4.has(key)) tags.push('O 4-threat finisher')
    }

    if (tags.length === 0) return null
    return `${key}: ${tags.join(' | ')}`
  }, [displayState.moves, hideDeadHexes, hoverHex, showThreatHighlights, threatTargets])
  const botSearchOptions = useMemo<BotSearchOptions>(() => {
    if (botThinkSeconds <= 0) {
      return {
        ...DEFAULT_BOT_SEARCH_OPTIONS,
        budget: { maxTimeMs: 0, maxNodes: 0 },
      }
    }

    const seconds = Math.max(0.1, Math.min(12, botThinkSeconds))
    const normalized = seconds / 12

    return {
      ...DEFAULT_BOT_SEARCH_OPTIONS,
      budget: {
        maxTimeMs: Math.round(seconds * 1000),
        maxNodes: Math.round(50000 + normalized * 750000),
      },
      turnCandidateCount: Math.max(5, Math.min(12, 5 + Math.floor(normalized * 7))),
      maxSimulationTurns: Math.max(2, Math.min(6, 2 + Math.floor(normalized * 4))),
      simulationRadius: Math.max(2, Math.min(6, 2 + Math.floor(normalized * 4))),
      simulationTopKFirstMoves: Math.max(1, Math.min(4, 1 + Math.floor(normalized * 3))),
    }
  }, [botThinkSeconds])

  const liveStatus = useMemo(() => {
    if (replayRecord) {
      return `Replay move ${replayStep}/${replayRecord.moveHistory.length}`
    }

    if (mode === 'sandbox') {
      return `Sandbox editing (${totalSandboxMoves} piece${totalSandboxMoves === 1 ? '' : 's'})`
    }

    if (displayState.winner) {
      return `${displayState.winner} wins with 6 in a row. Board locked.`
    }

    return `${displayState.turn} to move (${displayState.placementsLeft} placement${displayState.placementsLeft === 1 ? '' : 's'} left)`
  }, [displayState.placementsLeft, displayState.turn, displayState.winner, mode, replayRecord, replayStep, totalSandboxMoves])

  const syncFromWireBoard = useCallback((wireBoard: unknown, wireHistory?: unknown) => {
    const moves = boardObjectToMap(wireBoard)
    const moveHistory = moveHistoryObjectToArray(wireHistory)
    dispatchLive({ type: 'sync', moves, moveHistory: moveHistory.length > 0 ? moveHistory : undefined })
  }, [])

  const leaveRoom = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
    setJoinedRoom(null)
    setWsStatus('disconnected')
  }, [])

  const openSocket = useCallback(
    (firstMessage: Record<string, unknown>, fallbackJoinedRoom: string | null = null) => {
      if (!wsUrl) {
        setNetworkError('Missing VITE_WS_URL. Set it from stack output before joining.')
        return
      }

      setNetworkError(null)

      wsRef.current?.close()
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      setWsStatus('connecting')

      ws.onopen = () => {
        ws.send(JSON.stringify(firstMessage))
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            type?: string
            roomId?: string
            gameId?: string
            boardState?: unknown
            moveHistory?: unknown
            participants?: ParticipantMap
            message?: string
          }

          if (message.type === 'state_snapshot') {
            if (message.boardState) {
              syncFromWireBoard(message.boardState, message.moveHistory)
            }

            const resolvedRoom = message.roomId ?? fallbackJoinedRoom
            setJoinedRoom(resolvedRoom)
            if (resolvedRoom) {
              setGameCodeInput(resolvedRoom)
            }
            if (message.gameId) {
              setTrackedGameId(message.gameId)
            }
            if (message.participants) {
              setTrackedParticipants(message.participants)
            }
            setWsStatus('connected')
            return
          }

          if (message.type === 'move_applied') {
            if (message.boardState) {
              syncFromWireBoard(message.boardState, message.moveHistory)
            }
            if (message.gameId) {
              setTrackedGameId(message.gameId)
            }
            if (message.participants) {
              setTrackedParticipants(message.participants)
            }
            return
          }

          if (message.type === 'move_undone') {
            if (message.boardState) {
              syncFromWireBoard(message.boardState, message.moveHistory)
            }
            if (message.gameId) {
              setTrackedGameId(message.gameId)
            }
            if (message.participants) {
              setTrackedParticipants(message.participants)
            }
            return
          }

          if (message.type === 'error') {
            setNetworkError(message.message ?? 'WebSocket error')
            return
          }
        } catch {
          setNetworkError('Received malformed message from server.')
        }
      }

      ws.onerror = () => {
        setNetworkError('WebSocket connection failed.')
      }

      ws.onclose = () => {
        setWsStatus('disconnected')
        setJoinedRoom(null)
      }
    },
    [syncFromWireBoard, wsUrl],
  )

  const hostGame = useCallback(() => {
    if (!wsUrl) {
      setNetworkError('Missing VITE_WS_URL. Set it from stack output before joining.')
      return
    }

    const participants = buildParticipants(autoBotEnabled, autoBotSide, null)
    setTrackedParticipants(participants)
    openSocket({ action: 'create', participants, gameMode: 'live-room' })
  }, [autoBotEnabled, autoBotSide, openSocket, wsUrl])

  const joinGame = useCallback(() => {
    const roomId = gameCodeInput.trim().toUpperCase()
    if (!roomId || roomId.length > 5 || !/^[A-Z0-9]+$/.test(roomId)) {
      setNetworkError('Game code must be 1-5 letters/numbers.')
      return
    }

    openSocket(
      {
        action: 'join',
        roomId,
      },
      roomId,
    )
  }, [gameCodeInput, openSocket])

  const copyTrackedLink = useCallback(async () => {
    if (!trackedGameUrl) return

    try {
      await navigator.clipboard.writeText(trackedGameUrl)
      setTrackedGameNotice('Tracked game link copied.')
    } catch {
      setTrackedGameNotice(`Tracked game link: ${trackedGameUrl}`)
    }
  }, [trackedGameUrl])

  const saveTrackedSnapshot = useCallback(async () => {
    try {
      setTrackedGameNotice(null)
      setNetworkError(null)

      const participants = buildParticipants(autoBotEnabled, autoBotSide, joinedRoom)
      const snapshotState = mode === 'sandbox' ? sandboxState : liveState
      const response = await fetch(`${apiBaseUrl}/games`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          roomId: joinedRoom,
          gameMode: mode === 'sandbox' ? 'sandbox' : joinedRoom ? 'live-room-snapshot' : 'local-live',
          status: snapshotState.winner ? 'completed' : 'snapshot',
          resultType: snapshotState.winner ? 'win' : 'snapshot',
          winner: snapshotState.winner,
          participants,
          moveHistory: snapshotState.moveHistory,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to save tracked game.')
      }

      const payload = (await response.json()) as { gameId: string; path: string }
      setTrackedGameId(payload.gameId)
      setTrackedParticipants(participants)
      const url = typeof window === 'undefined' ? payload.path : `${window.location.origin}${payload.path}`
      setTrackedGameNotice(`Tracked game saved: ${url}`)
    } catch (error) {
      setNetworkError(error instanceof Error ? error.message : 'Failed to save tracked game.')
    }
  }, [apiBaseUrl, autoBotEnabled, autoBotSide, joinedRoom, liveState, mode, sandboxState])

  const handleModeChange = useCallback(
    (nextMode: Mode) => {
      if (nextMode === mode || isReplayMode) return

      if (nextMode === 'sandbox') {
        dispatchSandbox({ type: 'load', state: liveState })
      } else if (!joinedRoom) {
        dispatchLive({
          type: 'sync',
          moves: sandboxState.moves,
          moveHistory: sandboxState.moveHistory,
        })
      }

      setMode(nextMode)
      setNetworkError(null)
    },
    [isReplayMode, joinedRoom, liveState, mode, sandboxState.moveHistory, sandboxState.moves],
  )

  const toggleThemeTone = useCallback(() => {
    setPaletteId((current) => (isDarkPalette(current) ? lastLightPaletteRef.current : lastDarkPaletteRef.current))
  }, [])

  const applyAppearancePreset = useCallback((nextPalette: PaletteId, nextPieceStyle?: PieceStyle) => {
    setPaletteId(nextPalette)
    if (nextPieceStyle) {
      setPieceStyle(nextPieceStyle)
    }
  }, [])

  const placeMove = useCallback(
    (q: number, r: number) => {
      if (isReplayMode) {
        return
      }

      if (mode === 'sandbox') {
        setNetworkError(null)
        if (sandboxBrush === 'erase') {
          dispatchSandbox({ type: 'erase', q, r })
          return
        }

        dispatchSandbox({ type: 'placeMark', q, r, mark: sandboxBrush })
        return
      }

      if (mode === 'live') {
        if (liveState.winner) {
          setNetworkError(`Game over: ${liveState.winner} already won.`)
          return
        }

        if (playAs !== 'any' && liveState.turn !== playAs) {
          setNetworkError(`You are set to play as ${playAs}. It is ${liveState.turn}'s turn.`)
          return
        }

        setNetworkError(null)

        if (joinedRoom && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              action: 'place',
              q,
              r,
              mark: liveState.turn,
            }),
          )
          return
        }

        dispatchLive({ type: 'place', q, r })
        return
      }
    },
    [isReplayMode, joinedRoom, liveState.turn, liveState.winner, mode, playAs, sandboxBrush],
  )

  const undoMove = useCallback(() => {
    if (isReplayMode) return

    if (mode === 'sandbox') {
      dispatchSandbox({ type: 'undo' })
      return
    }

    if (joinedRoom && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          action: 'undo',
        }),
      )
      return
    }

    dispatchLive({ type: 'undo' })
  }, [isReplayMode, joinedRoom, mode])

  const runBotTurn = useCallback(async () => {
    if (isBotThinking) return
    if (isReplayMode) return
    if (mode !== 'live') return

    const sourceState = liveState

    if (sourceState.winner) {
      setNetworkError('Game already has a winner.')
      return
    }

    setIsBotThinking(true)
    setLiveBotNodes(0)
    setLiveBotPlayouts(0)
    setLiveBotBoardEvals(0)
    setLiveBotElapsedMs(0)

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      const decision =
        botSearchOptions.budget.maxTimeMs > 0 && botSearchOptions.budget.maxNodes > 0
          ? await chooseBotTurnDetailedAsync(
              {
                moves: sourceState.moves,
                moveHistory: sourceState.moveHistory,
                turn: sourceState.turn,
                placementsLeft: sourceState.placementsLeft,
              },
              botTuning,
              botSearchOptions,
              {
                yieldEveryMs: 16,
                onProgress: (progress) => {
                  setLiveBotNodes(progress.nodesExpanded)
                  setLiveBotPlayouts(progress.playouts)
                  setLiveBotBoardEvals(progress.boardEvaluations)
                  setLiveBotElapsedMs(progress.elapsedMs)
                },
              },
            )
          : chooseBotTurnDetailed(
              {
                moves: sourceState.moves,
                moveHistory: sourceState.moveHistory,
                turn: sourceState.turn,
                placementsLeft: sourceState.placementsLeft,
              },
              botTuning,
              botSearchOptions,
            )

      setLastBotStats(decision.stats)
      const plannedMoves = decision.moves

      if (plannedMoves.length === 0) {
        return
      }

      setNetworkError(null)

      if (mode === 'live' && joinedRoom && wsRef.current?.readyState !== WebSocket.OPEN) {
        setNetworkError('Room socket is not connected. Rejoin or reconnect before bot play.')
        return
      }

      if (mode === 'live' && joinedRoom && wsRef.current?.readyState === WebSocket.OPEN) {
        for (const move of plannedMoves) {
          wsRef.current.send(
            JSON.stringify({
              action: 'place',
              q: move.q,
              r: move.r,
              mark: sourceState.turn,
            }),
          )
        }
        return
      }

      for (const move of plannedMoves) {
        dispatchLive({ type: 'place', q: move.q, r: move.r })
      }
    } finally {
      setIsBotThinking(false)
    }
  }, [
    botSearchOptions,
    botTuning,
    isBotThinking,
    isReplayMode,
    joinedRoom,
    liveState,
    mode,
  ])

  const setThreatWeight = (idx: number, value: number) => {
    setBotTuning((prev) => {
      const next = [...prev.threatWeights]
      next[idx] = clampValue(value, 0, 20000)
      return { ...prev, threatWeights: next }
    })
  }

  const setAutoBotMode = useCallback((side: 'off' | 'X' | 'O' | 'both') => {
    const botOwnsX = side === 'X' || side === 'both'
    const botOwnsO = side === 'O' || side === 'both'
    if ((playAs === 'X' && botOwnsX) || (playAs === 'O' && botOwnsO)) {
      setNetworkError(`Play as ${playAs} conflicts with bot control for ${playAs}. Choose the other side or Any.`)
      return false
    }

    if (side === 'off') {
      setAutoBotEnabled(false)
      lastAutoBotSignatureRef.current = ''
      setNetworkError(null)
      return true
    }

    setAutoBotSide(side)
    setAutoBotEnabled(true)
    lastAutoBotSignatureRef.current = ''
    setNetworkError(null)
    return true
  }, [playAs])

  const handlePlayAsChange = useCallback(
    (nextPlayAs: PlayAs) => {
      if ((nextPlayAs === 'X' && autoBotForX) || (nextPlayAs === 'O' && autoBotForO)) {
        setNetworkError(`Bot is already set to play ${nextPlayAs}. Choose the other side or Any.`)
        return
      }

      setPlayAs(nextPlayAs)
      setNetworkError(null)
    },
    [autoBotForO, autoBotForX],
  )

  const toggleAutoBotSide = useCallback(
    (side: Player) => {
      const nextX = side === 'X' ? !autoBotForX : autoBotForX
      const nextO = side === 'O' ? !autoBotForO : autoBotForO
      const nextMode = nextX && nextO ? 'both' : nextX ? 'X' : nextO ? 'O' : 'off'
      setAutoBotMode(nextMode)
    },
    [autoBotForO, autoBotForX, setAutoBotMode],
  )

  useEffect(() => {
    if (!autoBotEnabled || mode !== 'live' || liveState.winner) {
      return
    }

    const sideMatches = autoBotSide === 'both' || autoBotSide === liveState.turn
    if (!sideMatches) {
      return
    }

    const lastMove = liveState.moveHistory[liveState.moveHistory.length - 1]
    const lastMoveSig = lastMove ? `${lastMove.mark}@${lastMove.q},${lastMove.r}` : 'none'
    const signature = `${joinedRoom ?? 'local'}|${liveState.turn}|${liveState.placementsLeft}|${liveState.moveHistory.length}|${lastMoveSig}`
    if (lastAutoBotSignatureRef.current === signature) {
      return
    }
    lastAutoBotSignatureRef.current = signature

    const timer = window.setTimeout(() => {
      void runBotTurn()
    }, 180)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    autoBotEnabled,
    autoBotSide,
    joinedRoom,
    liveState.moveHistory,
    liveState.placementsLeft,
    liveState.turn,
    liveState.winner,
    mode,
    runBotTurn,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0 || size.height === 0) return

    const dpr = window.devicePixelRatio || 1
    const targetWidth = Math.floor(size.width * dpr)
    const targetHeight = Math.floor(size.height * dpr)

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    ctx.fillStyle = theme.boardBackground
    ctx.fillRect(0, 0, size.width, size.height)

    const left = (0 - camera.x) / camera.zoom
    const right = (size.width - camera.x) / camera.zoom
    const top = (0 - camera.y) / camera.zoom
    const bottom = (size.height - camera.y) / camera.zoom

    const rMin = Math.floor(top / (1.5 * BASE_HEX_SIZE)) - 3
    const rMax = Math.ceil(bottom / (1.5 * BASE_HEX_SIZE)) + 3

    const strokeGrid = theme.boardGridStroke
    const fillGrid = theme.boardGridFill
    const deadHexCache = new Map<string, boolean>()
    const cachedIsDead = (q: number, r: number) => {
      const key = toKey(q, r)
      if (deadHexCache.has(key)) {
        return deadHexCache.get(key) ?? false
      }
      const dead = isDeadHex(displayState.moves, q, r)
      deadHexCache.set(key, dead)
      return dead
    }

    for (let r = rMin; r <= rMax; r += 1) {
      const qMin = Math.floor(left / (BASE_HEX_SIZE * SQRT3) - r / 2) - 3
      const qMax = Math.ceil(right / (BASE_HEX_SIZE * SQRT3) - r / 2) + 3

      for (let q = qMin; q <= qMax; q += 1) {
        const key = toKey(q, r)
        const occupied = displayState.moves.has(key)
        const deadCell = cachedIsDead(q, r)
        if (hideDeadHexes && deadCell && !occupied) {
          continue
        }

        const world = axialToWorld(q, r, BASE_HEX_SIZE)
        const screen = worldToScreen(world.x, world.y)
        const displaySize = BASE_HEX_SIZE * camera.zoom

        ctx.beginPath()
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI / 180) * (60 * i - 30)
          const px = screen.x + displaySize * Math.cos(angle)
          const py = screen.y + displaySize * Math.sin(angle)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()

        ctx.fillStyle = deadCell ? theme.deadHexFill : fillGrid
        ctx.fill()
        if (showPressureMap && !occupied) {
          const xPressure = liveEvaluation.xPressureMap.get(key) ?? 0
          const oPressure = liveEvaluation.oPressureMap.get(key) ?? 0
          const xNorm = liveEvaluation.xPressureMax > 0 ? xPressure / liveEvaluation.xPressureMax : 0
          const oNorm = liveEvaluation.oPressureMax > 0 ? oPressure / liveEvaluation.oPressureMax : 0
          const net = xNorm - oNorm
          const intensity = Math.max(0, Math.min(1, Math.abs(net)))
          if (intensity > 0.025) {
            ctx.save()
            ctx.globalAlpha = 0.12 + 0.36 * intensity
            ctx.fillStyle = net >= 0 ? theme.xFill : theme.oFill
            ctx.fill()
            ctx.restore()
          }
        }
        ctx.strokeStyle = deadCell ? theme.deadHexStroke : strokeGrid
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    const drawPlanningSegments = (segmentKeys: Iterable<string>, dashedAlpha: number) => {
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      for (const segmentKey of segmentKeys) {
        const [startKey, endKey] = segmentKey.split('|')
        if (!startKey || !endKey) continue

        const start = fromKey(startKey)
        const end = fromKey(endKey)
        const startWorld = axialToWorld(start.q, start.r, BASE_HEX_SIZE)
        const endWorld = axialToWorld(end.q, end.r, BASE_HEX_SIZE)
        const startScreen = worldToScreen(startWorld.x, startWorld.y)
        const endScreen = worldToScreen(endWorld.x, endWorld.y)

        ctx.beginPath()
        ctx.moveTo(startScreen.x, startScreen.y)
        ctx.lineTo(endScreen.x, endScreen.y)
        ctx.strokeStyle = theme.boardBackground
        ctx.lineWidth = Math.max(4, camera.zoom * 5.5)
        ctx.stroke()

        ctx.beginPath()
        ctx.moveTo(startScreen.x, startScreen.y)
        ctx.lineTo(endScreen.x, endScreen.y)
        ctx.strokeStyle = theme.hoverPlan
        ctx.globalAlpha = dashedAlpha
        ctx.lineWidth = Math.max(2.4, camera.zoom * 3.2)
        ctx.setLineDash([Math.max(6, camera.zoom * 7), Math.max(4, camera.zoom * 5)])
        ctx.stroke()
        ctx.setLineDash([])
      }

      ctx.restore()
    }

    if (planningPreviewSegments.length > 0) {
      drawPlanningSegments(planningPreviewSegments, 0.46)
    }

    if (planningState.segments.size > 0) {
      drawPlanningSegments(planningState.segments, 0.8)
    }

    if (hoverHex) {
      const key = toKey(hoverHex.q, hoverHex.r)
      const showHover = mode === 'sandbox' || (!displayState.moves.has(key) && !displayState.winner)
      if (showHover) {
        const world = axialToWorld(hoverHex.q, hoverHex.r, BASE_HEX_SIZE)
        const screen = worldToScreen(world.x, world.y)
        const displaySize = BASE_HEX_SIZE * camera.zoom

        ctx.beginPath()
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI / 180) * (60 * i - 30)
          const px = screen.x + displaySize * Math.cos(angle)
          const py = screen.y + displaySize * Math.sin(angle)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()

        ctx.strokeStyle = mode === 'live' ? theme.hoverLive : theme.hoverPlan
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    for (const [key, player] of displayState.moves.entries()) {
      const { q, r } = fromKey(key)
      const world = axialToWorld(q, r, BASE_HEX_SIZE)
      const screen = worldToScreen(world.x, world.y)
      const radius = BASE_HEX_SIZE * camera.zoom * 0.55
      const highlight = highlightedKeys.has(key)

      ctx.save()

      if (highlight) {
        const ringSize = BASE_HEX_SIZE * camera.zoom * 1.05
        ctx.beginPath()
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI / 180) * (60 * i - 30)
          const px = screen.x + ringSize * Math.cos(angle)
          const py = screen.y + ringSize * Math.sin(angle)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.fillStyle = theme.highlightFill
        ctx.fill()
        ctx.strokeStyle = theme.highlightRing
        ctx.lineWidth = Math.max(1.6, camera.zoom * 1.4)
        ctx.stroke()
      }

      const strokeColor = player === 'X' ? theme.xColor : theme.oColor
      const fillColor = player === 'X' ? theme.xFill : theme.oFill

      if (pieceStyle === 'fill') {
        const fillHexSize = BASE_HEX_SIZE * camera.zoom * 0.88
        ctx.beginPath()
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI / 180) * (60 * i - 30)
          const px = screen.x + fillHexSize * Math.cos(angle)
          const py = screen.y + fillHexSize * Math.sin(angle)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.fillStyle = fillColor
        ctx.fill()
        ctx.strokeStyle = strokeColor
        ctx.lineWidth = Math.max(1.4, camera.zoom * 1.8)
        ctx.stroke()
      } else {
        ctx.lineWidth = Math.max(2, camera.zoom * 2.4)
        ctx.strokeStyle = strokeColor

        if (player === 'X') {
          ctx.beginPath()
          ctx.moveTo(screen.x - radius, screen.y - radius)
          ctx.lineTo(screen.x + radius, screen.y + radius)
          ctx.moveTo(screen.x + radius, screen.y - radius)
          ctx.lineTo(screen.x - radius, screen.y + radius)
          ctx.stroke()
        } else {
          ctx.beginPath()
          ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      if (showMoveNumbers) {
        const moveNo = moveNumberByKey.get(key)
        if (typeof moveNo === 'number') {
          ctx.font = `700 ${Math.max(10, camera.zoom * 12)}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.lineWidth = Math.max(2, camera.zoom * 2.2)
          ctx.strokeStyle = pieceStyle === 'fill' ? 'rgba(255, 255, 255, 0.92)' : 'rgba(245, 245, 245, 0.98)'
          ctx.fillStyle = strokeColor
          ctx.strokeText(String(moveNo), screen.x, screen.y)
          ctx.fillText(String(moveNo), screen.x, screen.y)
        }
      }

      ctx.restore()
    }

    for (const [key, player] of planningState.marks.entries()) {
      if (displayState.moves.has(key)) continue

      const { q, r } = fromKey(key)
      const world = axialToWorld(q, r, BASE_HEX_SIZE)
      const screen = worldToScreen(world.x, world.y)
      const overlaySize = BASE_HEX_SIZE * camera.zoom * 0.72
      const overlayRadius = BASE_HEX_SIZE * camera.zoom * 0.42
      const strokeColor = player === 'X' ? theme.xColor : theme.oColor
      const fillColor = player === 'X' ? theme.xFill : theme.oFill

      ctx.save()
      ctx.globalAlpha = 0.28
      ctx.beginPath()
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 180) * (60 * i - 30)
        const px = screen.x + overlaySize * Math.cos(angle)
        const py = screen.y + overlaySize * Math.sin(angle)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fillStyle = fillColor
      ctx.fill()

      ctx.globalAlpha = 0.82
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = Math.max(1.8, camera.zoom * 2.1)
      ctx.setLineDash([Math.max(5, camera.zoom * 5), Math.max(4, camera.zoom * 4)])

      if (player === 'X') {
        ctx.beginPath()
        ctx.moveTo(screen.x - overlayRadius, screen.y - overlayRadius)
        ctx.lineTo(screen.x + overlayRadius, screen.y + overlayRadius)
        ctx.moveTo(screen.x + overlayRadius, screen.y - overlayRadius)
        ctx.lineTo(screen.x - overlayRadius, screen.y + overlayRadius)
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.arc(screen.x, screen.y, overlayRadius, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.setLineDash([])
      ctx.restore()
    }

    if (showThreatHighlights) {
      const drawThreatDot = (key: string, fill: string, line: string, radiusScale: number) => {
        if (displayState.moves.has(key)) return
        const { q, r } = fromKey(key)
        const world = axialToWorld(q, r, BASE_HEX_SIZE)
        const screen = worldToScreen(world.x, world.y)
        const radius = BASE_HEX_SIZE * camera.zoom * radiusScale
        ctx.save()
        ctx.beginPath()
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
        ctx.fillStyle = fill
        ctx.fill()
        ctx.strokeStyle = line
        ctx.lineWidth = Math.max(1.2, camera.zoom * 1.4)
        ctx.stroke()
        ctx.restore()
      }

      for (const key of threatTargets.x4) {
        drawThreatDot(key, theme.threatX4, theme.xColor, 0.2)
      }
      for (const key of threatTargets.o4) {
        drawThreatDot(key, theme.threatO4, theme.oColor, 0.2)
      }
      for (const key of threatTargets.x5) {
        drawThreatDot(key, theme.threatX5, theme.xColor, 0.28)
      }
      for (const key of threatTargets.o5) {
        drawThreatDot(key, theme.threatO5, theme.oColor, 0.28)
      }
    }

    if (displayState.winner && mode !== 'sandbox') {
      ctx.save()
      ctx.fillStyle = 'rgba(10, 18, 14, 0.22)'
      ctx.fillRect(0, 0, size.width, size.height)
      ctx.fillStyle = '#f8fafc'
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)'
      ctx.lineWidth = 4
      ctx.font = '700 34px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = `${displayState.winner} wins`
      ctx.strokeText(label, size.width / 2, size.height / 2 - 12)
      ctx.fillText(label, size.width / 2, size.height / 2 - 12)
      ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText(
        'Board is locked. Use Undo or Sync/Clear to continue.',
        size.width / 2,
        size.height / 2 + 18,
      )
      ctx.restore()
    }
  }, [
    camera.x,
    camera.y,
    camera.zoom,
    displayState.moveHistory,
    displayState.moves,
    displayState.winner,
    hoverHex,
    mode,
    liveEvaluation.oPressureMap,
    liveEvaluation.oPressureMax,
    liveEvaluation.xPressureMap,
    liveEvaluation.xPressureMax,
    size.height,
    size.width,
    highlightedKeys,
    hideDeadHexes,
    moveNumberByKey,
    pieceStyle,
    showMoveNumbers,
    showPressureMap,
    showThreatHighlights,
    threatTargets,
    theme,
    planningState.marks,
    planningState.segments,
    planningPreviewSegments,
    worldToScreen,
  ])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) {
      event.preventDefault()
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    dragRef.current = {
      pointerId: event.pointerId,
      mode: event.button === 2 ? 'annotate' : 'pan',
      lastX: x,
      lastY: y,
      started: false,
      anchorHex: getHexAtScreen(x, y),
    }

    if (event.button === 2) {
      setPlanningPreviewSegments([])
    }

    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      setHoverHex(getHexAtScreen(x, y))
      return
    }

    const dx = x - drag.lastX
    const dy = y - drag.lastY

    if (drag.mode === 'pan' && !drag.started && Math.hypot(dx, dy) > 3) {
      drag.started = true
    }

    if (drag.mode === 'pan' && drag.started) {
      setCamera((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
    }

    if (drag.mode === 'annotate') {
      const hex = getHexAtScreen(x, y)
      if (drag.anchorHex) {
        const snappedHex = snapHexToPlanningAxis(drag.anchorHex, hex)
        const previewSegments =
          snappedHex.q === drag.anchorHex.q && snappedHex.r === drag.anchorHex.r
            ? []
            : planningPathSegmentKeys(drag.anchorHex, snappedHex)
        drag.started = previewSegments.length > 0
        setPlanningPreviewSegments(previewSegments)
      }
    }

    drag.lastX = x
    drag.lastY = y
    setHoverHex(getHexAtScreen(x, y))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const drag = dragRef.current

    if (drag && drag.pointerId === event.pointerId) {
      if (drag.mode === 'annotate') {
        event.preventDefault()
      }

      const annotatePreviewSegments =
        drag.mode === 'annotate' && drag.anchorHex
          ? (() => {
              const hex = getHexAtScreen(x, y)
              const snappedHex = snapHexToPlanningAxis(drag.anchorHex as HoverHex, hex)
              if (snappedHex.q === drag.anchorHex.q && snappedHex.r === drag.anchorHex.r) {
                return []
              }
              return planningPathSegmentKeys(drag.anchorHex, snappedHex)
            })()
          : []

      if (!drag.started && drag.mode === 'pan') {
        const hex = getHexAtScreen(x, y)
        placeMove(hex.q, hex.r)
      }

      if (!drag.started && drag.mode === 'annotate') {
        const segmentKey = planningSegmentAtScreen(x, y)
        if (segmentKey) {
          dispatchPlanning({
            type: 'removeSegments',
            segmentKeys: collectPlanningLineSegmentKeys(planningState.segments, segmentKey),
          })
        } else {
          const hex = getHexAtScreen(x, y)
          dispatchPlanning({ type: 'cycleMark', q: hex.q, r: hex.r })
        }
      }

      if (drag.mode === 'annotate' && annotatePreviewSegments.length > 0) {
        dispatchPlanning({ type: 'toggleSegments', segmentKeys: annotatePreviewSegments })
      }

      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    dragRef.current = null
    setPlanningPreviewSegments([])
  }

  const onPointerLeave = () => {
    setHoverHex(null)
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()

    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    const zoomMultiplier = Math.exp(-event.deltaY * 0.0012)

    setCamera((prev) => {
      const oldZoom = prev.zoom
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * zoomMultiplier))
      if (newZoom === oldZoom) return prev

      const worldX = (x - prev.x) / oldZoom
      const worldY = (y - prev.y) / oldZoom

      return {
        x: x - worldX * newZoom,
        y: y - worldY * newZoom,
        zoom: newZoom,
      }
    })
  }

  const resetView = () => {
    setCamera((prev) => ({
      x: size.width / 2,
      y: size.height / 2,
      zoom: prev.zoom,
    }))
  }

  const clearAll = () => {
    if (isReplayMode) return

    if (mode === 'sandbox') {
      dispatchSandbox({ type: 'clear' })
      setSandboxBrush('X')
      return
    }

    if (joinedRoom && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          action: 'sync',
        }),
      )
      return
    }

    dispatchLive({ type: 'clear' })
  }

  return (
    <div className={`app-shell ${theme.dark ? 'theme-dark' : ''}`} style={appThemeVars}>
      <header className="topbar">
        <div className="title-block">
          <h1>{isReplayMode ? 'Tracked Game Replay' : 'Hexagonal Tic-Tac-Toe'}</h1>
        </div>
        <div className="topbar-actions">
          {!isReplayMode ? (
            <label className="play-as topbar-mode">
              Mode
              <select value={mode} onChange={(event) => handleModeChange(event.target.value as Mode)}>
                <option value="live">Live</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </label>
          ) : null}
          {!isReplayMode && mode === 'live' ? (
            <div className="quick-bot" role="group" aria-label="Bot controls">
              <span className="quick-bot-label">Bot</span>
              <button className="quick-bot-action" onClick={() => void runBotTurn()} type="button" disabled={!!displayState.winner || isBotThinking}>
                {isBotThinking ? 'Thinking…' : 'Next move'}
              </button>
              <button
                className={autoBotForX ? 'quick-bot-action active' : 'quick-bot-action'}
                onClick={() => toggleAutoBotSide('X')}
                type="button"
              >
                Auto X
              </button>
              <button
                className={autoBotForO ? 'quick-bot-action active' : 'quick-bot-action'}
                onClick={() => toggleAutoBotSide('O')}
                type="button"
              >
                Auto O
              </button>
            </div>
          ) : null}
          {!isReplayMode && mode === 'sandbox' ? (
            <div className="topbar-brushes" role="group" aria-label="Sandbox brush">
              <button className={sandboxBrush === 'X' ? 'active sandbox-x' : 'sandbox-x'} onClick={() => setSandboxBrush('X')} type="button">
                Place X
              </button>
              <button className={sandboxBrush === 'O' ? 'active sandbox-o' : 'sandbox-o'} onClick={() => setSandboxBrush('O')} type="button">
                Place O
              </button>
              <button
                className={sandboxBrush === 'erase' ? 'active sandbox-erase' : 'sandbox-erase'}
                onClick={() => setSandboxBrush('erase')}
                type="button"
              >
                Erase
              </button>
            </div>
          ) : null}
          {isReplayMode ? <div className="room-pill">Replay: {replayGameId}</div> : null}
          {showConnectedStatus ? <div className="ws-pill connected">Connected</div> : null}
          <div className="room-pill">{joinedRoom ? `Room: ${joinedRoom}` : participantModeLabel ?? 'Local only'}</div>
          {currentGameId ? <div className="room-pill">Game ID: {currentGameId.slice(0, 12)}</div> : null}
          {!isReplayMode ? (
            <button className="toggle-hud" onClick={() => void saveTrackedSnapshot()} type="button">
              Save Game Snapshot
            </button>
          ) : null}
          {trackedGameUrl ? (
            <button className="toggle-hud" onClick={() => void copyTrackedLink()} type="button">
              Copy link
            </button>
          ) : null}
          <button className="toggle-hud" onClick={() => setShowRulesModal(true)} type="button">
            Rules
          </button>
        </div>
      </header>

      {displayState.winner && !isReplayMode ? (
        <div className="winner-banner">
          {displayState.winner} wins. {mode === 'sandbox' ? 'Keep editing or clear the setup.' : 'Game locked until undo or sync/reset.'}
        </div>
      ) : null}
      {replayRecord ? (
        <div className="winner-banner">
          {participantModeLabel ?? 'Tracked replay'} · {replayRecord.participants.X.label} vs {replayRecord.participants.O.label}
        </div>
      ) : null}

      {networkError ? <div className="network-error">{networkError}</div> : null}
      {trackedGameNotice ? <div className="tracked-notice">{trackedGameNotice}</div> : null}
      {replayError ? <div className="network-error">{replayError}</div> : null}
      {showRulesModal ? (
        <div className="rules-modal-backdrop" onClick={() => setShowRulesModal(false)} role="presentation">
          <section
            className="rules-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Game rules"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>Rules</h2>
            <p>X places one mark on the very first turn.</p>
            <p>After that, each turn is two placements by the active player.</p>
            <p>First player to make six in a row wins.</p>
            <div className="button-row">
              <button onClick={() => setShowRulesModal(false)} type="button">
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <main className="board-wrapper" ref={wrapperRef}>
        <div className="board-floating-controls">
          {hasPlanningAnnotations ? (
            <button className="toggle-hud" onClick={() => dispatchPlanning({ type: 'clear' })} type="button">
              Clear planning
            </button>
          ) : null}
          <button className="toggle-hud board-theme-toggle" onClick={toggleThemeTone} type="button">
            {theme.dark ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
        <canvas
          ref={canvasRef}
          className={`board ${(isReplayMode || (mode === 'live' && displayState.winner)) ? 'board-locked' : ''}`}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onWheel={onWheel}
          aria-label="Hexagonal tic-tac-toe board"
        />
        <section className={`board-dock ${dockOpen ? 'is-open' : 'is-collapsed'}`}>
            <button
              className="board-dock-toggle"
              onClick={() => setDockOpen((prev) => !prev)}
              type="button"
              aria-expanded={dockOpen}
              aria-controls="board-dock-shell"
            >
              {dockOpen ? 'Hide controls' : 'Show controls'}
            </button>
            {dockOpen ? (
              <section className="board-dock-shell" id="board-dock-shell">
                <div className="compact-status-row">
                  <span>{isReplayMode ? 'Replay' : modeLabel}</span>
                  <span>{liveStatus}</span>
                  <span>Zoom {(camera.zoom * 100).toFixed(0)}%</span>
                  {participantModeLabel ? <span>{participantModeLabel}</span> : null}
                </div>

                {isReplayMode ? (
                  <details className="dock-panel" open>
                    <summary>Replay</summary>
                    <section className="controls">
                      <div className="button-row">
                        <button onClick={() => setReplayStep(0)} type="button" disabled={!replayRecord || replayStep <= 0}>
                          Start
                        </button>
                        <button
                          onClick={() => setReplayStep((prev) => Math.max(0, prev - 1))}
                          type="button"
                          disabled={!replayRecord || replayStep <= 0}
                        >
                          Prev
                        </button>
                        <button
                          onClick={() => setReplayStep((prev) => Math.min(replayRecord?.moveHistory.length ?? 0, prev + 1))}
                          type="button"
                          disabled={!replayRecord || replayStep >= replayRecord.moveHistory.length}
                        >
                          Next
                        </button>
                        <button
                          onClick={() => setReplayStep(replayRecord?.moveHistory.length ?? 0)}
                          type="button"
                          disabled={!replayRecord || replayStep >= replayRecord.moveHistory.length}
                        >
                          End
                        </button>
                        <button onClick={resetView} type="button">
                          Recenter view
                        </button>
                      </div>
                      <div className="button-row">
                        <div className="drag-readout">
                          {isReplayLoading
                            ? 'Loading tracked game…'
                            : replayRecord
                              ? `Step ${replayStep} of ${replayRecord.moveHistory.length}`
                              : 'Replay unavailable'}
                        </div>
                      </div>
                    </section>
                  </details>
                ) : (
                  <>
                    <details className="dock-panel">
                      <summary>Connection</summary>
                      <section className="controls">
                        <div className="network-panel">
                          <button onClick={hostGame} type="button">
                            Host game
                          </button>
                          <input
                            value={gameCodeInput}
                            onChange={(e) => setGameCodeInput(e.target.value.toUpperCase())}
                            placeholder="Game code"
                            maxLength={5}
                          />
                          <button onClick={joinGame} type="button">
                            Join by code
                          </button>
                          <button onClick={leaveRoom} type="button" disabled={!joinedRoom}>
                            Leave
                          </button>
                        </div>
                      </section>
                    </details>

                    <details className="dock-panel">
                      <summary>Play</summary>
                      <section className="controls">
                        <div className="button-row">
                          {mode === 'live' ? (
                            <label className="play-as">
                              Play as
                              <select value={playAs} onChange={(event) => handlePlayAsChange(event.target.value as PlayAs)}>
                                <option value="any">Any</option>
                                <option value="X">X</option>
                                <option value="O">O</option>
                              </select>
                            </label>
                          ) : null}
                          <button onClick={undoMove} type="button" disabled={!canUndo}>
                            {mode === 'sandbox' ? 'Undo edit' : 'Undo last'}
                          </button>
                          <button onClick={clearAll} type="button">
                            {mode === 'sandbox' ? 'Clear sandbox' : joinedRoom ? 'Sync room' : 'Clear local'}
                          </button>
                          <button onClick={() => dispatchPlanning({ type: 'clear' })} type="button">
                            Clear notes
                          </button>
                          {mode === 'sandbox' ? (
                            <button className={sandboxBrush === 'X' ? 'active sandbox-x' : 'sandbox-x'} onClick={() => setSandboxBrush('X')} type="button">
                              Place X
                            </button>
                          ) : null}
                          {mode === 'sandbox' ? (
                            <button className={sandboxBrush === 'O' ? 'active sandbox-o' : 'sandbox-o'} onClick={() => setSandboxBrush('O')} type="button">
                              Place O
                            </button>
                          ) : null}
                          {mode === 'sandbox' ? (
                            <button
                              className={sandboxBrush === 'erase' ? 'active sandbox-erase' : 'sandbox-erase'}
                              onClick={() => setSandboxBrush('erase')}
                              type="button"
                            >
                              Erase
                            </button>
                          ) : null}
                          <button onClick={resetView} type="button">
                            Recenter view
                          </button>
                          <div className="zoom-readout">Zoom: {(camera.zoom * 100).toFixed(0)}%</div>
                          <div className="drag-readout">
                            {mode === 'sandbox' ? `Sandbox pieces: ${totalSandboxMoves}` : `Moves played: ${totalLiveMoves}`}
                          </div>
                          <div className="drag-readout">Right-click: ghost X/O, drag links</div>
                        </div>
                      </section>
                    </details>

                    <details className="dock-panel">
                      <summary>Bot</summary>
                      <section className="controls">
                        {mode === 'sandbox' ? (
                          <div className="drag-readout">Switch back to Live in the top bar to let the bot play from this setup.</div>
                        ) : (
                          <section className="bot-panel">
                            <div className="button-row">
                              <div className="auto-bot-group" role="group" aria-label="Bot autoplay mode">
                                <button
                                  type="button"
                                  className={!autoBotEnabled ? 'active' : ''}
                                  onClick={() => setAutoBotMode('off')}
                                >
                                  Auto off
                                </button>
                                <button
                                  type="button"
                                  className={autoBotEnabled && autoBotSide === 'O' ? 'active auto-easy' : 'auto-easy'}
                                  onClick={() => setAutoBotMode('O')}
                                >
                                  Auto O
                                </button>
                                <button
                                  type="button"
                                  className={autoBotEnabled && autoBotSide === 'X' ? 'active' : ''}
                                  onClick={() => setAutoBotMode('X')}
                                >
                                  Auto X
                                </button>
                                <button
                                  type="button"
                                  className={autoBotEnabled && autoBotSide === 'both' ? 'active auto-easy' : 'auto-easy'}
                                  onClick={() => setAutoBotMode('both')}
                                >
                                  Auto both
                                </button>
                              </div>
                              <div className="drag-readout">
                                {`Bot will place ${displayState.placementsLeft} mark${displayState.placementsLeft === 1 ? '' : 's'} from ${mode}`}
                              </div>
                            </div>
                            <div className="bot-metrics">
                              <div className="stat">
                                <span>X Threats</span>
                                <strong className="threat-line-x">
                                  1:{liveEvaluation.xThreats[1]} 2:{liveEvaluation.xThreats[2]} 3:{liveEvaluation.xThreats[3]} 4:
                                  {liveEvaluation.xThreats[4]} 5:{liveEvaluation.xThreats[5]}
                                </strong>
                              </div>
                              <div className="stat">
                                <span>O Threats</span>
                                <strong className="threat-line-o">
                                  1:{liveEvaluation.oThreats[1]} 2:{liveEvaluation.oThreats[2]} 3:{liveEvaluation.oThreats[3]} 4:
                                  {liveEvaluation.oThreats[4]} 5:{liveEvaluation.oThreats[5]}
                                </strong>
                              </div>
                              <div className="stat">
                                <span>X One-turn wins</span>
                                <strong>{liveEvaluation.xOneTurnWins}</strong>
                              </div>
                              <div className="stat">
                                <span>O One-turn wins</span>
                                <strong>{liveEvaluation.oOneTurnWins}</strong>
                              </div>
                            </div>
                            <div className="button-row">
                              <button onClick={() => void runBotTurn()} type="button" disabled={!!displayState.winner || isBotThinking}>
                                {isBotThinking ? 'Bot thinking…' : `Play bot turn (${displayState.turn})`}
                              </button>
                            </div>
                            <div className="compute-panel">
                              <label className="compute-label" htmlFor="bot-compute-slider">
                                Search time limit: {botThinkSeconds.toFixed(1)}s
                                <HintPill text="0.0s uses greedy only. Higher values run budgeted MCTS with guided (non-random) simulation and larger node caps." />
                              </label>
                              <input
                                id="bot-compute-slider"
                                type="range"
                                min={0}
                                max={12}
                                step={0.1}
                                value={botThinkSeconds}
                                onChange={(event) => setBotThinkSeconds(Math.max(0, Math.min(12, Number(event.target.value) || 0)))}
                              />
                              <div className="compute-meta">
                                {botThinkSeconds <= 0
                                  ? 'Mode: Greedy (no search)'
                                  : `Mode: MCTS | Budget: ${botSearchOptions.budget.maxTimeMs}ms or ${botSearchOptions.budget.maxNodes.toLocaleString()} nodes`}
                              </div>
                              {lastBotStats ? (
                                <div className="compute-meta">
                                  Last run: {lastBotStats.mode.toUpperCase()} | {(lastBotStats.elapsedMs / 1000).toFixed(3)}s | board evals{' '}
                                  {lastBotStats.boardEvaluations.toLocaleString()} | nodes {lastBotStats.nodesExpanded.toLocaleString()} | playouts{' '}
                                  {lastBotStats.playouts.toLocaleString()} | tree depth {lastBotStats.maxDepthTurns} turns | root lines{' '}
                                  {lastBotStats.rootCandidates} | stop {lastBotStats.stopReason}
                                </div>
                              ) : null}
                              {isBotThinking ? (
                                <div className="compute-meta">
                                  Thinking now: {(liveBotElapsedMs / 1000).toFixed(2)}s | board evals {liveBotBoardEvals.toLocaleString()} | nodes{' '}
                                  {liveBotNodes.toLocaleString()} | playouts {liveBotPlayouts.toLocaleString()}
                                </div>
                              ) : null}
                            </div>
                            <details className="tuning-panel">
                              <summary>Advanced tuning (threat + diversity model)</summary>
                              <div className="tuning-grid">
                                <label>
                                  <span className="tuning-label-text">
                                    Threat-2 base <HintPill text="Small value for uncontested 2-threat windows and preemptive control pressure." />
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={20000}
                                    step={1}
                                    value={botTuning.threatWeights[2]}
                                    onChange={(e) => setThreatWeight(2, Number(e.target.value))}
                                  />
                                </label>
                                <label>
                                  <span className="tuning-label-text">
                                    Threat-3 base <HintPill text="Base value of each uncontested 3-in-a-row threat window." />
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={20000}
                                    step={1}
                                    value={botTuning.threatWeights[3]}
                                    onChange={(e) => setThreatWeight(3, Number(e.target.value))}
                                  />
                                </label>
                                <label>
                                  <span className="tuning-label-text">
                                    Threat-4/5 base <HintPill text="Shared base value for uncontested 4-threats and 5-threats." />
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={20000}
                                    step={1}
                                    value={botTuning.threatWeights[4]}
                                    onChange={(e) => {
                                      const value = clampValue(Number(e.target.value) || 0, 0, 20000)
                                      setBotTuning((prev) => {
                                        const next = [...prev.threatWeights]
                                        next[4] = value
                                        next[5] = value
                                        return { ...prev, threatWeights: next }
                                      })
                                    }}
                                  />
                                </label>
                                <label>
                                  <span className="tuning-label-text">
                                    Threat vs diversity mix{' '}
                                    <HintPill text="0.00 = threat severity only, 1.00 = diversity only. Middle values blend both normalized signals." />
                                  </span>
                                  <div>
                                    <input
                                      type="range"
                                      min={0}
                                      max={1}
                                      step={0.01}
                                      value={botTuning.threatDiversityBlend}
                                      onChange={(e) =>
                                        setBotTuning((prev) => ({
                                          ...prev,
                                          threatDiversityBlend: clampValue(Number(e.target.value) || 0, 0, 1),
                                        }))
                                      }
                                    />
                                    <div className="compute-meta">Value: {botTuning.threatDiversityBlend.toFixed(2)}</div>
                                  </div>
                                </label>
                                <label>
                                  <span className="tuning-label-text">
                                    Threat normalization scale{' '}
                                    <HintPill text="Saturation scale for raw threat severity before blending with diversity. Higher means slower saturation." />
                                  </span>
                                  <input
                                    type="number"
                                    min={1}
                                    max={50000}
                                    step={50}
                                    value={botTuning.threatSeverityScale}
                                    onChange={(e) =>
                                      setBotTuning((prev) => ({
                                        ...prev,
                                        threatSeverityScale: clampValue(Number(e.target.value) || 0, 1, 50000),
                                      }))
                                    }
                                  />
                                </label>
                                <label>
                                  <span className="tuning-label-text">
                                    Defense weight{' '}
                                    <HintPill text="Offense/defense slider. Higher values prioritize suppressing opponent offense; lower values favor pure self-pressure." />
                                  </span>
                                  <div>
                                    <input
                                      type="range"
                                      min={0}
                                      max={2}
                                      step={0.05}
                                      value={botTuning.defenseWeight}
                                      onChange={(e) =>
                                        setBotTuning((prev) => ({
                                          ...prev,
                                          defenseWeight: clampValue(Number(e.target.value) || 0, 0, 2),
                                        }))
                                      }
                                    />
                                    <div className="compute-meta">Value: {botTuning.defenseWeight.toFixed(2)}</div>
                                  </div>
                                </label>
                              </div>
                              <div className="button-row">
                                <button onClick={() => setBotTuning(DEFAULT_BOT_TUNING)} type="button">
                                  Reset to defaults
                                </button>
                              </div>
                            </details>
                          </section>
                        )}
                      </section>
                    </details>
                  </>
                )}

                <details className="dock-panel">
                  <summary>Appearance</summary>
                  <section className="controls">
                    <div className="button-row">
                      <label className="play-as">
                        Move numbers
                        <input
                          type="checkbox"
                          checked={showMoveNumbers}
                          onChange={(event) => setShowMoveNumbers(event.target.checked)}
                        />
                      </label>
                      <label className="play-as">
                        Mark style
                        <select value={pieceStyle} onChange={(event) => setPieceStyle(event.target.value as PieceStyle)}>
                          <option value="glyph">X / O</option>
                          <option value="fill">Filled hexes</option>
                        </select>
                      </label>
                      <label className="play-as">
                        Hide dead hexes
                        <input
                          type="checkbox"
                          checked={hideDeadHexes}
                          onChange={(event) => setHideDeadHexes(event.target.checked)}
                        />
                      </label>
                      <label className="play-as">
                        Highlight 4/5 threats
                        <input
                          type="checkbox"
                          checked={showThreatHighlights}
                          onChange={(event) => setShowThreatHighlights(event.target.checked)}
                        />
                      </label>
                      <label className="play-as">
                        Show pressure map
                        <input
                          type="checkbox"
                          checked={showPressureMap}
                          onChange={(event) => setShowPressureMap(event.target.checked)}
                        />
                      </label>
                      <div className="auto-bot-group" role="group" aria-label="Color palette options">
                        <button
                          type="button"
                          className={paletteId === 'spruce' ? 'active' : ''}
                          onClick={() => setPaletteId('spruce')}
                        >
                          Spruce
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'sunset' ? 'active' : ''}
                          onClick={() => setPaletteId('sunset')}
                        >
                          Sunset
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'graphite' ? 'active' : ''}
                          onClick={() => setPaletteId('graphite')}
                        >
                          Graphite
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'midnight' ? 'active' : ''}
                          onClick={() => setPaletteId('midnight')}
                        >
                          Midnight
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'volcanic' ? 'active' : ''}
                          onClick={() => setPaletteId('volcanic')}
                        >
                          Volcanic
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'cobalt' ? 'active' : ''}
                          onClick={() => setPaletteId('cobalt')}
                        >
                          Cobalt
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'amber-night' ? 'active' : ''}
                          onClick={() => setPaletteId('amber-night')}
                        >
                          Amber Night
                        </button>
                        <button
                          type="button"
                          className={paletteId === 'arena' && pieceStyle === 'fill' ? 'active' : ''}
                          onClick={() => applyAppearancePreset('arena', 'fill')}
                        >
                          Arena
                        </button>
                      </div>
                      {hoverTrainingLabel ? <div className="drag-readout">{hoverTrainingLabel}</div> : null}
                    </div>
                  </section>
                </details>
              </section>
            ) : null}
          </section>
      </main>
    </div>
  )
}

export default App
