import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'

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

  const dragRef = useRef<{
    pointerId: number
    lastX: number
    lastY: number
    started: boolean
  } | null>(null)

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
  const canUndo = liveState.moveHistory.length > 0 && !liveState.winner
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

  const liveStatus = useMemo(() => {
    if (liveState.winner) {
      return `${liveState.winner} wins with 6 in a row`
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
    [joinedRoom, liveState.turn, mode, planBrush, playAs],
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
          <button className="toggle-hud" onClick={() => setShowHud((prev) => !prev)} type="button">
            {showHud ? 'Hide menus' : 'Show menus'}
          </button>
        </div>
      </header>

      {networkError ? <div className="network-error">{networkError}</div> : null}

      <main className="board-wrapper" ref={wrapperRef}>
        <canvas
          ref={canvasRef}
          className="board"
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
              </section>
            </details>

            <details className="help-panel dock-panel">
              <summary>Rules and UI limits</summary>
              <div className="help-content">
                <p>
                  <strong>Rules:</strong> X places one mark on the first turn. After that, each turn is two placements by the
                  active player. First player to make six in a row wins.
                </p>
                <p>
                  <strong>Highlights:</strong> the most recent live placements (up to two cells) are highlighted on the board.
                </p>
                <p>
                  <strong>Multiplayer limitations:</strong> there is no player identity yet, so either person in a room can place
                  the current turn's mark. Game codes are shared and not private.
                </p>
                <p>
                  <strong>Backtracking:</strong> use <code>Undo last</code> in Live mode to remove the most recent move (works in
                  local and synced room play).
                </p>
              </div>
            </details>
          </section>
        ) : null}
      </main>
    </div>
  )
}

export default App
