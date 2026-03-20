import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'

type Player = 'X' | 'O'
type Mode = 'live' | 'plan'

type Camera = {
  x: number
  y: number
  zoom: number
}

type HoverHex = {
  q: number
  r: number
}

type LiveGameState = {
  moves: Map<string, Player>
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
      type: 'clear'
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

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function fromKey(key: string): { q: number; r: number } {
  const [q, r] = key.split(',').map(Number)
  return { q, r }
}

function nextPlayer(player: Player): Player {
  return player === 'X' ? 'O' : 'X'
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

function createInitialLiveState(): LiveGameState {
  return {
    moves: new Map(),
    turn: 'X',
    placementsLeft: 1,
    winner: null,
  }
}

function liveReducer(state: LiveGameState, action: LiveAction): LiveGameState {
  if (action.type === 'clear') {
    return createInitialLiveState()
  }

  if (state.winner) return state

  const key = toKey(action.q, action.r)
  if (state.moves.has(key)) return state

  const nextMoves = new Map(state.moves)
  nextMoves.set(key, state.turn)

  if (isWinningPlacement(nextMoves, action.q, action.r, state.turn)) {
    return {
      ...state,
      moves: nextMoves,
      winner: state.turn,
      placementsLeft: 0,
    }
  }

  if (state.placementsLeft > 1) {
    return {
      ...state,
      moves: nextMoves,
      placementsLeft: state.placementsLeft - 1,
    }
  }

  return {
    ...state,
    moves: nextMoves,
    turn: nextPlayer(state.turn),
    placementsLeft: 2,
  }
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
  let x = q
  let z = r
  let y = -x - z

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

function App() {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const initializedRef = useRef(false)

  const [size, setSize] = useState({ width: 0, height: 0 })
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [hoverHex, setHoverHex] = useState<HoverHex | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [mode, setMode] = useState<Mode>('live')

  const [liveState, dispatchLive] = useReducer(liveReducer, undefined, createInitialLiveState)
  const [planBrush, setPlanBrush] = useState<Player>('X')
  const [planMoves, setPlanMoves] = useState<Map<string, Player>>(new Map())

  const dragRef = useRef<{
    pointerId: number
    lastX: number
    lastY: number
    started: boolean
  } | null>(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })

    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!initializedRef.current && size.width > 0 && size.height > 0) {
      setCamera({ x: size.width / 2, y: size.height / 2, zoom: 1 })
      initializedRef.current = true
    }
  }, [size.height, size.width])

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

  const modeLabel = useMemo(() => {
    return mode === 'live' ? 'Live game' : 'Plan mode'
  }, [mode])

  const liveStatus = useMemo(() => {
    if (liveState.winner) {
      return `${liveState.winner} wins with 6 in a row`
    }

    return `${liveState.turn} to move (${liveState.placementsLeft} placement${liveState.placementsLeft === 1 ? '' : 's'} left)`
  }, [liveState.placementsLeft, liveState.turn, liveState.winner])

  const placeMove = useCallback(
    (q: number, r: number) => {
      if (mode === 'live') {
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
    [mode, planBrush],
  )

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

      ctx.save()
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
    liveState.winner,
    mode,
    planMoves,
    size.height,
    size.width,
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
    dispatchLive({ type: 'clear' })
    setPlanMoves(new Map())
    setPlanBrush('X')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Hexagonal Tic-Tac-Toe Prototype</h1>
          <p>
            Drag to pan, scroll to zoom, click to place. Rule set: X places 1 on opening turn, then both players place 2 per
            turn. First 6 in a row wins.
          </p>
        </div>
      </header>

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
      </main>

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
          <button
            className={mode === 'live' ? 'active' : ''}
            onClick={() => setMode('live')}
            type="button"
          >
            Live mode
          </button>
          <button
            className={mode === 'plan' ? 'active' : ''}
            onClick={() => setMode('plan')}
            type="button"
          >
            Plan mode
          </button>
          <button
            className={planBrush === 'X' ? 'active plan-x' : 'plan-x'}
            onClick={() => setPlanBrush('X')}
            type="button"
          >
            Plan X
          </button>
          <button
            className={planBrush === 'O' ? 'active plan-o' : 'plan-o'}
            onClick={() => setPlanBrush('O')}
            type="button"
          >
            Plan O
          </button>
          <button onClick={clearPlan} type="button">
            Clear plan
          </button>
          <button onClick={clearAll} type="button">
            Clear all
          </button>
          <button onClick={resetView} type="button">
            Recenter view
          </button>
          <div className="zoom-readout">Zoom: {(camera.zoom * 100).toFixed(0)}%</div>
          <div className="drag-readout">{isDragging ? 'Panning…' : 'Ready'}</div>
        </div>
      </section>
    </div>
  )
}

export default App
