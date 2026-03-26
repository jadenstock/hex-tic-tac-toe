import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import {
  DEFAULT_BOT_SEARCH_OPTIONS,
  DEFAULT_BOT_TUNING,
  chooseBotTurnDetailed,
  evaluateBoardState,
  type BotSearchStats,
  type BotSearchOptions,
  type BotTuning,
} from './bot/engine'

type Player = 'X' | 'O'
type Mode = 'live' | 'plan'
type PlayAs = 'any' | Player

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
}

type LiveGameState = {
  moves: Map<string, Player>
  moveHistory: MoveRecord[]
  turn: Player
  placementsLeft: number
  winner: Player | null
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

type WsStatus = 'disconnected' | 'connecting' | 'connected'

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

    if ((mark === 'X' || mark === 'O') && Number.isInteger(q) && Number.isInteger(r)) {
      next.push({ q, r, mark })
    }
  }

  return next
}

function HintPill({ text }: { text: string }) {
  return (
    <span className="hint-pill" data-tip={text} tabIndex={0} aria-label={text}>
      ?
    </span>
  )
}

function App() {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const initializedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  const [size, setSize] = useState({ width: 0, height: 0 })
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [hoverHex, setHoverHex] = useState<HoverHex | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [mode, setMode] = useState<Mode>('live')
  const [playAs, setPlayAs] = useState<PlayAs>('any')

  const [liveState, dispatchLive] = useReducer(liveReducer, undefined, createInitialLiveState)
  const [planBrush, setPlanBrush] = useState<Player>('X')
  const [planMoves, setPlanMoves] = useState<Map<string, Player>>(new Map())

  const [gameCodeInput, setGameCodeInput] = useState('')
  const [joinedRoom, setJoinedRoom] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected')
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [showHud, setShowHud] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia('(min-width: 900px)').matches
  })
  const [dockTab, setDockTab] = useState<'play' | 'bot'>('play')
  const [autoBotEnabled, setAutoBotEnabled] = useState(false)
  const [autoBotSide, setAutoBotSide] = useState<'X' | 'O' | 'both'>('O')
  const [botThinkSeconds, setBotThinkSeconds] = useState(0)
  const [botTuning, setBotTuning] = useState<BotTuning>(DEFAULT_BOT_TUNING)
  const [lastBotStats, setLastBotStats] = useState<BotSearchStats | null>(null)
  const [showDangerFlags, setShowDangerFlags] = useState(false)
  const [showRulesModal, setShowRulesModal] = useState(false)

  const dragRef = useRef<{
    pointerId: number
    lastX: number
    lastY: number
    started: boolean
  } | null>(null)
  const lastAutoBotSignatureRef = useRef('')

  const wsUrl = import.meta.env.VITE_WS_URL as string | undefined

  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

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

  const totalLiveMoves = liveState.moves.size
  const totalPlanMoves = planMoves.size
  const canUndo = liveState.moveHistory.length > 0
  const highlightedKeys = useMemo(() => {
    if (liveState.moveHistory.length === 0) {
      return new Set<string>()
    }

    const next = new Set<string>()
    const lastMark = liveState.moveHistory[liveState.moveHistory.length - 1].mark

    for (let i = liveState.moveHistory.length - 1; i >= 0; i -= 1) {
      const move = liveState.moveHistory[i]
      if (move.mark !== lastMark) break
      next.add(toKey(move.q, move.r))
      if (next.size >= 2) break
    }

    return next
  }, [liveState.moveHistory])

  const modeLabel = useMemo(() => {
    return mode === 'live' ? 'Live game' : 'Plan mode'
  }, [mode])
  const liveEvaluation = useMemo(() => evaluateBoardState(liveState.moves, botTuning), [botTuning, liveState.moves])
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
      simulationRadius: Math.max(2, Math.min(6, Math.min(botTuning.candidateRadius, 2 + Math.floor(normalized * 5)))),
      simulationTopKFirstMoves: Math.max(1, Math.min(4, 1 + Math.floor(normalized * 3))),
    }
  }, [botThinkSeconds, botTuning.candidateRadius])

  const liveStatus = useMemo(() => {
    if (liveState.winner) {
      return `${liveState.winner} wins with 6 in a row. Board locked.`
    }

    return `${liveState.turn} to move (${liveState.placementsLeft} placement${liveState.placementsLeft === 1 ? '' : 's'} left)`
  }, [liveState.placementsLeft, liveState.turn, liveState.winner])

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
            boardState?: unknown
            moveHistory?: unknown
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
            setWsStatus('connected')
            return
          }

          if (message.type === 'move_applied') {
            if (message.boardState) {
              syncFromWireBoard(message.boardState, message.moveHistory)
            }
            return
          }

          if (message.type === 'move_undone') {
            if (message.boardState) {
              syncFromWireBoard(message.boardState, message.moveHistory)
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

    openSocket({ action: 'create' })
  }, [openSocket, wsUrl])

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

  const placeMove = useCallback(
    (q: number, r: number) => {
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

      const key = toKey(q, r)

      setPlanMoves((prev) => {
        const next = new Map(prev)
        const existing = next.get(key)

        if (existing === planBrush) {
          next.delete(key)
          return next
        }

        next.set(key, planBrush)
        return next
      })
    },
    [joinedRoom, liveState.turn, liveState.winner, mode, planBrush, playAs],
  )

  const undoMove = useCallback(() => {
    if (mode !== 'live') return

    if (joinedRoom && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          action: 'undo',
        }),
      )
      return
    }

    dispatchLive({ type: 'undo' })
  }, [joinedRoom, mode])

  const runBotTurn = useCallback(() => {
    if (mode !== 'live') {
      setNetworkError('Bot play is only available in Live mode.')
      return
    }

    if (liveState.winner) {
      setNetworkError('Game already has a winner.')
      return
    }

    const decision = chooseBotTurnDetailed(
      {
        moves: liveState.moves,
        moveHistory: liveState.moveHistory,
        turn: liveState.turn,
        placementsLeft: liveState.placementsLeft,
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

    if (joinedRoom && wsRef.current?.readyState !== WebSocket.OPEN) {
      setNetworkError('Room socket is not connected. Rejoin or reconnect before bot play.')
      return
    }

    if (joinedRoom && wsRef.current?.readyState === WebSocket.OPEN) {
      for (const move of plannedMoves) {
        wsRef.current.send(
          JSON.stringify({
            action: 'place',
            q: move.q,
            r: move.r,
            mark: liveState.turn,
          }),
        )
      }
      return
    }

    for (const move of plannedMoves) {
      dispatchLive({ type: 'place', q: move.q, r: move.r })
    }
  }, [
    botSearchOptions,
    botTuning,
    joinedRoom,
    liveState.moveHistory,
    liveState.moves,
    liveState.placementsLeft,
    liveState.turn,
    liveState.winner,
    mode,
  ])

  const setThreatWeight = (idx: number, value: number) => {
    setBotTuning((prev) => {
      const next = [...prev.threatWeights]
      next[idx] = value
      return { ...prev, threatWeights: next }
    })
  }

  const setBreadthWeight = (idx: number, value: number) => {
    setBotTuning((prev) => {
      const next = [...prev.threatBreadthWeights]
      next[idx] = value
      return { ...prev, threatBreadthWeights: next }
    })
  }

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
      runBotTurn()
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

    ctx.fillStyle = '#f5f9f7'
    ctx.fillRect(0, 0, size.width, size.height)

    const left = (0 - camera.x) / camera.zoom
    const right = (size.width - camera.x) / camera.zoom
    const top = (0 - camera.y) / camera.zoom
    const bottom = (size.height - camera.y) / camera.zoom

    const rMin = Math.floor(top / (1.5 * BASE_HEX_SIZE)) - 3
    const rMax = Math.ceil(bottom / (1.5 * BASE_HEX_SIZE)) + 3

    const strokeGrid = '#c8d4cd'
    const fillGrid = '#eef5f1'

    for (let r = rMin; r <= rMax; r += 1) {
      const qMin = Math.floor(left / (BASE_HEX_SIZE * SQRT3) - r / 2) - 3
      const qMax = Math.ceil(right / (BASE_HEX_SIZE * SQRT3) - r / 2) + 3

      for (let q = qMin; q <= qMax; q += 1) {
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

        ctx.fillStyle = fillGrid
        ctx.fill()
        ctx.strokeStyle = strokeGrid
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    if (hoverHex) {
      const key = toKey(hoverHex.q, hoverHex.r)
      const showHover = mode === 'plan' || (!liveState.moves.has(key) && !liveState.winner)
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

        ctx.strokeStyle = mode === 'live' ? '#0b6e4f' : '#6f42c1'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    for (const [key, player] of liveState.moves.entries()) {
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
        ctx.fillStyle = 'rgba(251, 191, 36, 0.22)'
        ctx.fill()
        ctx.strokeStyle = '#b45309'
        ctx.lineWidth = Math.max(1.6, camera.zoom * 1.4)
        ctx.stroke()
      }

      ctx.lineWidth = Math.max(2, camera.zoom * 2.4)
      ctx.strokeStyle = player === 'X' ? '#1e2f97' : '#8a1930'

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

      ctx.restore()
    }

    for (const [key, player] of planMoves.entries()) {
      const { q, r } = fromKey(key)
      const world = axialToWorld(q, r, BASE_HEX_SIZE)
      const screen = worldToScreen(world.x, world.y)
      const radius = BASE_HEX_SIZE * camera.zoom * 0.35

      ctx.save()
      ctx.lineWidth = Math.max(1.5, camera.zoom * 1.8)
      ctx.strokeStyle = player === 'X' ? 'rgba(126, 34, 206, 0.8)' : 'rgba(234, 88, 12, 0.82)'
      ctx.setLineDash([4, 4])

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

      ctx.restore()
    }

    if (liveState.winner) {
      ctx.save()
      ctx.fillStyle = 'rgba(10, 18, 14, 0.22)'
      ctx.fillRect(0, 0, size.width, size.height)
      ctx.fillStyle = '#f8fafc'
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)'
      ctx.lineWidth = 4
      ctx.font = '700 34px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = `${liveState.winner} wins`
      ctx.strokeText(label, size.width / 2, size.height / 2 - 12)
      ctx.fillText(label, size.width / 2, size.height / 2 - 12)
      ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText('Board is locked. Use Undo or Sync/Clear to continue.', size.width / 2, size.height / 2 + 18)
      ctx.restore()
    }
  }, [
    camera.x,
    camera.y,
    camera.zoom,
    hoverHex,
    liveState.moves,
    liveState.moveHistory,
    liveState.winner,
    mode,
    planMoves,
    size.height,
    size.width,
    highlightedKeys,
    worldToScreen,
  ])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    dragRef.current = {
      pointerId: event.pointerId,
      lastX: x,
      lastY: y,
      started: false,
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

    if (!drag.started && Math.hypot(dx, dy) > 3) {
      drag.started = true
      setIsDragging(true)
    }

    if (drag.started) {
      setCamera((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
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
      if (!drag.started) {
        const hex = getHexAtScreen(x, y)
        placeMove(hex.q, hex.r)
      }
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    dragRef.current = null
    setIsDragging(false)
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

  const clearPlan = () => {
    setPlanMoves(new Map())
    setPlanBrush('X')
  }

  const clearAll = () => {
    setPlanMoves(new Map())
    setPlanBrush('X')

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
    <div className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <h1>Hexagonal Tic-Tac-Toe</h1>
        </div>
        <div className="topbar-actions">
          <div className={`ws-pill ${wsStatus}`}>{wsStatus}</div>
          <div className="room-pill">{joinedRoom ? `Game: ${joinedRoom}` : 'Local only'}</div>
          <button className="toggle-hud" onClick={() => setShowRulesModal(true)} type="button">
            Rules
          </button>
          <button className="toggle-hud" onClick={() => setShowHud((prev) => !prev)} type="button">
            {showHud ? 'Hide menus' : 'Show menus'}
          </button>
        </div>
      </header>

      {liveState.winner ? <div className="winner-banner">{liveState.winner} wins. Game locked until undo or sync/reset.</div> : null}

      {networkError ? <div className="network-error">{networkError}</div> : null}
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
        <canvas
          ref={canvasRef}
          className={`board ${liveState.winner ? 'board-locked' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onWheel={onWheel}
          aria-label="Hexagonal tic-tac-toe board"
        />
        {showHud ? (
          <section className="board-dock">
            <details className="dock-panel" open>
              <summary>Game and connection</summary>
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
            </details>

            <details className="dock-panel" open>
              <summary>Play controls</summary>
              <section className="controls">
                <div className="dock-tabs" role="tablist" aria-label="Board controls">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={dockTab === 'play'}
                    className={dockTab === 'play' ? 'active' : ''}
                    onClick={() => setDockTab('play')}
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={dockTab === 'bot'}
                    className={dockTab === 'bot' ? 'active' : ''}
                    onClick={() => setDockTab('bot')}
                  >
                    Bot
                  </button>
                </div>
                <div className="status-grid">
                  <div className="stat">
                    <span>Mode</span>
                    <strong>{modeLabel}</strong>
                  </div>
                  <div className="stat">
                    <span>Live status</span>
                    <strong>{liveStatus}</strong>
                  </div>
                  <div className="stat">
                    <span>Plan brush</span>
                    <strong>{planBrush}</strong>
                  </div>
                  <div className="stat">
                    <span>Moves</span>
                    <strong>
                      {totalLiveMoves} live / {totalPlanMoves} plan
                    </strong>
                  </div>
                </div>
                {dockTab === 'play' ? (
                  <div className="button-row">
                    <label className="play-as">
                      Play as
                      <select value={playAs} onChange={(event) => setPlayAs(event.target.value as PlayAs)}>
                        <option value="any">Any</option>
                        <option value="X">X</option>
                        <option value="O">O</option>
                      </select>
                    </label>
                    <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')} type="button">
                      Live mode
                    </button>
                    <button className={mode === 'plan' ? 'active' : ''} onClick={() => setMode('plan')} type="button">
                      Plan mode
                    </button>
                    <button className={planBrush === 'X' ? 'active plan-x' : 'plan-x'} onClick={() => setPlanBrush('X')} type="button">
                      Plan X
                    </button>
                    <button className={planBrush === 'O' ? 'active plan-o' : 'plan-o'} onClick={() => setPlanBrush('O')} type="button">
                      Plan O
                    </button>
                    <button onClick={clearPlan} type="button">
                      Clear plan
                    </button>
                    <button onClick={undoMove} type="button" disabled={!canUndo}>
                      Undo last
                    </button>
                    <button onClick={clearAll} type="button">
                      {joinedRoom ? 'Sync room' : 'Clear local'}
                    </button>
                    <button onClick={resetView} type="button">
                      Recenter view
                    </button>
                    <div className="zoom-readout">Zoom: {(camera.zoom * 100).toFixed(0)}%</div>
                    <div className="drag-readout">{isDragging ? 'Panning...' : 'Ready'}</div>
                  </div>
                ) : (
                  <section className="bot-panel">
                    <div className="score-bar" aria-label="Board evaluation score bar">
                      <div className="score-x" style={{ width: `${(liveEvaluation.xShare * 100).toFixed(1)}%` }}>
                        X {(liveEvaluation.xShare * 100).toFixed(0)}%
                      </div>
                      <div className="score-o">O {(100 - liveEvaluation.xShare * 100).toFixed(0)}%</div>
                    </div>
                    <div className="bot-metrics">
                      <div className="stat">
                        <span>X Score</span>
                        <strong>{liveEvaluation.xScore}</strong>
                      </div>
                      <div className="stat">
                        <span>O Score</span>
                        <strong>{liveEvaluation.oScore}</strong>
                      </div>
                      <div className="stat">
                        <span>X Threats</span>
                        <strong>
                          1:{liveEvaluation.xThreats[1]} 2:{liveEvaluation.xThreats[2]} 3:{liveEvaluation.xThreats[3]} 4:
                          {liveEvaluation.xThreats[4]} 5:{liveEvaluation.xThreats[5]}
                        </strong>
                      </div>
                      <div className="stat">
                        <span>O Threats</span>
                        <strong>
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
                      {showDangerFlags ? (
                        <div className="stat">
                          <span>X Will win next turn</span>
                          <strong>{liveEvaluation.xWillWinNextTurn ? 'Yes' : 'No'}</strong>
                        </div>
                      ) : null}
                      {showDangerFlags ? (
                        <div className="stat">
                          <span>O Will win next turn</span>
                          <strong>{liveEvaluation.oWillWinNextTurn ? 'Yes' : 'No'}</strong>
                        </div>
                      ) : null}
                    </div>
                    <div className="button-row">
                      <button onClick={runBotTurn} type="button" disabled={mode !== 'live' || !!liveState.winner}>
                        {botThinkSeconds <= 0 ? `Play greedy turn for ${liveState.turn}` : `Play search turn for ${liveState.turn}`}
                      </button>
                      <label className="play-as">
                        Show danger flags
                        <input
                          type="checkbox"
                          checked={showDangerFlags}
                          onChange={(event) => setShowDangerFlags(event.target.checked)}
                        />
                      </label>
                      <label className="play-as">
                        Auto-play bot
                        <input
                          type="checkbox"
                          checked={autoBotEnabled}
                          onChange={(event) => {
                            setAutoBotEnabled(event.target.checked)
                            lastAutoBotSignatureRef.current = ''
                          }}
                        />
                      </label>
                      <label className="play-as">
                        Bot side
                        <select
                          value={autoBotSide}
                          onChange={(event) => {
                            setAutoBotSide(event.target.value as 'X' | 'O' | 'both')
                            lastAutoBotSignatureRef.current = ''
                          }}
                        >
                          <option value="both">Both</option>
                          <option value="X">X</option>
                          <option value="O">O</option>
                        </select>
                      </label>
                      <div className="drag-readout">
                        {mode === 'live'
                          ? `Bot will place ${liveState.placementsLeft} mark${liveState.placementsLeft === 1 ? '' : 's'}`
                          : 'Switch to Live mode for bot play'}
                      </div>
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
                          Last run: {lastBotStats.mode.toUpperCase()} | {(lastBotStats.elapsedMs / 1000).toFixed(3)}s | nodes{' '}
                          {lastBotStats.nodesExpanded.toLocaleString()} | playouts {lastBotStats.playouts.toLocaleString()} | depth{' '}
                          {lastBotStats.maxDepthTurns} turns | root cands {lastBotStats.rootCandidates} | stop {lastBotStats.stopReason}
                        </div>
                      ) : null}
                    </div>
                    <details className="tuning-panel">
                      <summary>Advanced tuning (opinionated defaults)</summary>
                      <div className="tuning-grid">
                        <label>
                          <span className="tuning-label-text">
                            Threat-3 base <HintPill text="Base value of each uncontested 3-in-a-row threat window." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threatWeights[3]}
                            onChange={(e) => setThreatWeight(3, Number(e.target.value))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-4 base <HintPill text="Base value of each uncontested 4-in-a-row threat window." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threatWeights[4]}
                            onChange={(e) => setThreatWeight(4, Number(e.target.value))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-5 base <HintPill text="Base value of each uncontested 5-in-a-row threat window." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threatWeights[5]}
                            onChange={(e) => setThreatWeight(5, Number(e.target.value))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-3 breadth{' '}
                            <HintPill text="Extra bonus for having many 3-threats at once (scales with count squared)." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threatBreadthWeights[3]}
                            onChange={(e) => setBreadthWeight(3, Number(e.target.value))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-4 breadth{' '}
                            <HintPill text="Extra bonus for multiple 4-threats at once; encourages fork creation." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threatBreadthWeights[4]}
                            onChange={(e) => setBreadthWeight(4, Number(e.target.value))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-5 breadth <HintPill text="Extra bonus for multiple 5-threats; usually near forced wins." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threatBreadthWeights[5]}
                            onChange={(e) => setBreadthWeight(5, Number(e.target.value))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Defense weight{' '}
                            <HintPill text="Blend between offense and defense. 0.5 means balanced; higher values prioritize reducing opponent score." />
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.05}
                            value={botTuning.defenseWeight}
                            onChange={(e) =>
                              setBotTuning((prev) => ({
                                ...prev,
                                defenseWeight: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Immediate danger penalty{' '}
                            <HintPill text="Large penalty applied whenever opponent still has any one-turn win threat group after your move." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.immediateDangerPenalty}
                            onChange={(e) =>
                              setBotTuning((prev) => ({
                                ...prev,
                                immediateDangerPenalty: Math.max(0, Number(e.target.value) || 0),
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            One-turn win bonus{' '}
                            <HintPill text="Bonus per unique empty cell that completes a win in one turn (up to two placements)." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.oneTurnWinBonus}
                            onChange={(e) => setBotTuning((prev) => ({ ...prev, oneTurnWinBonus: Number(e.target.value) }))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-3 cluster bonus <HintPill text="Extra emphasis on building dense groups of 3-threats." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threat3ClusterBonus}
                            onChange={(e) =>
                              setBotTuning((prev) => ({
                                ...prev,
                                threat3ClusterBonus: Number(e.target.value),
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-4 fork bonus{' '}
                            <HintPill text="Additional bonus when there is more than one 4-threat; models dual-threat pressure." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threat4ForkBonus}
                            onChange={(e) => setBotTuning((prev) => ({ ...prev, threat4ForkBonus: Number(e.target.value) }))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Threat-5 fork bonus{' '}
                            <HintPill text="Additional bonus when there is more than one 5-threat; often decisive." />
                          </span>
                          <input
                            type="number"
                            value={botTuning.threat5ForkBonus}
                            onChange={(e) => setBotTuning((prev) => ({ ...prev, threat5ForkBonus: Number(e.target.value) }))}
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Candidate radius{' '}
                            <HintPill text="How far from existing stones the bot considers candidate cells. Higher is wider but slower." />
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={7}
                            value={botTuning.candidateRadius}
                            onChange={(e) =>
                              setBotTuning((prev) => ({
                                ...prev,
                                candidateRadius: Math.max(1, Math.min(7, Number(e.target.value) || 1)),
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="tuning-label-text">
                            Top-K first moves{' '}
                            <HintPill text="For 2-placement turns, evaluate this many best first moves before choosing the line with best follow-up second move." />
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={botTuning.topKFirstMoves}
                            onChange={(e) =>
                              setBotTuning((prev) => ({
                                ...prev,
                                topKFirstMoves: Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1))),
                              }))
                            }
                          />
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

          </section>
        ) : null}
      </main>
    </div>
  )
}

export default App
