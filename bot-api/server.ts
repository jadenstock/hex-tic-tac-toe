import { createServer } from 'node:http'
import {
  buildTimedSearchOptions,
  chooseBotTurnDetailed,
  DEFAULT_BOT_TUNING,
  evaluateBoardState,
  type Player,
  WIN_DIRECTIONS,
  WIN_LENGTH,
} from '../src/bot/engine.ts'

type Coord = { q: number; r: number }
type Cell = Coord & { p: 'x' | 'o' }
type Board = {
  to_move: 'x' | 'o'
  cells: Cell[]
}
type MoveRequest = {
  board: Board
  time_limit?: number
}

type Capabilities = {
  meta: {
    name: string
    description: string
    version: string
    tags: string[]
  }
  stateless: {
    versions: {
      'v1-alpha': {
        api_root: string
        move_time_limit: true
      }
    }
  }
}

type ErrorBody = {
  error: string
}

const TURN_ENDPOINT_PATHS = new Set([
  '/v1-alpha/turn',
  '/stateless/v1-alpha/turn',
  '/v1/stateless/v1-alpha/turn',
])

const CAPABILITIES: Capabilities = {
  meta: {
    name: 'hex-ttt',
    description: 'Hexagonal tic-tac-toe bot adapter using the in-repo search engine.',
    version: process.env.BOT_VERSION ?? process.env.npm_package_version ?? '0.0.0',
    tags: ['hex-ttt', 'stateless', 'typescript', 'mcts', 'wasm'],
  },
  stateless: {
    versions: {
      'v1-alpha': {
        api_root: 'stateless/v1-alpha',
        move_time_limit: true,
      },
    },
  },
}

function toKey(q: number, r: number): string {
  return `${q},${r}`
}

function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Malformed JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
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

function parseRequestBody(input: unknown): { ok: true; value: MoveRequest } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Body must be an object.' }
  const body = input as Record<string, unknown>
  if (!body.board || typeof body.board !== 'object') return { ok: false, error: '`board` is required.' }

  const boardObj = body.board as Record<string, unknown>
  const toMove = boardObj.to_move
  if (toMove !== 'x' && toMove !== 'o') {
    return { ok: false, error: '`board.to_move` must be "x" or "o".' }
  }

  if (!Array.isArray(boardObj.cells)) {
    return { ok: false, error: '`board.cells` must be an array.' }
  }

  const seen = new Set<string>()
  const cells: Cell[] = []
  for (const rawCell of boardObj.cells) {
    if (!rawCell || typeof rawCell !== 'object') {
      return { ok: false, error: 'Each cell must be an object.' }
    }
    const cell = rawCell as Record<string, unknown>
    if (!isInteger(cell.q) || !isInteger(cell.r)) {
      return { ok: false, error: 'Each cell must have integer q and r.' }
    }
    if (cell.p !== 'x' && cell.p !== 'o') {
      return { ok: false, error: 'Each cell p must be "x" or "o".' }
    }
    const key = toKey(cell.q, cell.r)
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate cell coordinate ${key}.` }
    }
    seen.add(key)
    cells.push({ q: cell.q, r: cell.r, p: cell.p })
  }

  const timeLimit = body.time_limit
  if (timeLimit !== undefined && (typeof timeLimit !== 'number' || !Number.isFinite(timeLimit) || timeLimit < 0)) {
    return { ok: false, error: '`time_limit` must be a finite number >= 0.' }
  }

  return {
    ok: true,
    value: {
      board: {
        to_move: toMove,
        cells,
      },
      time_limit: typeof timeLimit === 'number' ? timeLimit : undefined,
    },
  }
}

function writeJson(
  res: import('node:http').ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS, GET')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.end(payload)
}

function error(res: import('node:http').ServerResponse, statusCode: number, message: string): void {
  writeJson(res, statusCode, { error: message } satisfies ErrorBody)
}

function countDirectional(
  boardMap: Map<string, Player>,
  q: number,
  r: number,
  dq: number,
  dr: number,
  player: Player,
): number {
  let count = 0
  let cq = q + dq
  let cr = r + dr
  while (boardMap.get(toKey(cq, cr)) === player) {
    count += 1
    cq += dq
    cr += dr
  }
  return count
}

function isWinningPlacement(boardMap: Map<string, Player>, q: number, r: number, player: Player): boolean {
  for (const [dq, dr] of WIN_DIRECTIONS) {
    const forward = countDirectional(boardMap, q, r, dq, dr, player)
    const backward = countDirectional(boardMap, q, r, -dq, -dr, player)
    if (1 + forward + backward >= WIN_LENGTH) {
      return true
    }
  }
  return false
}

function immediateWinInIfAny(boardMap: Map<string, Player>, playerJustMoved: Player): number | undefined {
  for (const [key, mark] of boardMap.entries()) {
    if (mark !== playerJustMoved) continue
    const [q, r] = key.split(',').map(Number)
    if (isWinningPlacement(boardMap, q, r, mark)) {
      return playerJustMoved === 'X' ? 1 : -1
    }
  }
  return undefined
}

function applyMove(
  boardMap: Map<string, Player>,
  line: Coord[],
  player: Player,
): { next: Map<string, Player>; valid: boolean } {
  const next = new Map(boardMap)
  for (const piece of line) {
    const key = toKey(piece.q, piece.r)
    if (next.has(key)) {
      return { next: boardMap, valid: false }
    }
    next.set(key, player)
  }
  return { next, valid: true }
}

const port = Number(process.env.PORT ?? '8080')

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    return error(res, 400, 'Bad request.')
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS') {
    return writeJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return writeJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && (url.pathname === '/capabilities.json' || url.pathname === '/v1/capabilities.json')) {
    return writeJson(res, 200, CAPABILITIES)
  }

  if (req.method !== 'POST' || !TURN_ENDPOINT_PATHS.has(url.pathname)) {
    return error(res, 404, 'Not found.')
  }

  try {
    const parsedBody = parseRequestBody(await readJsonBody(req))
    if (!parsedBody.ok) {
      return error(res, 400, parsedBody.error)
    }

    const payload = parsedBody.value
    const boardMap = new Map<string, Player>()
    for (const cell of payload.board.cells) {
      boardMap.set(toKey(cell.q, cell.r), cell.p === 'x' ? 'X' : 'O')
    }

    const turnState = turnStateFromMoveCount(boardMap.size)
    const requestedTurn: Player = payload.board.to_move === 'x' ? 'X' : 'O'
    if (turnState.turn !== requestedTurn) {
      return error(
        res,
        400,
        `Illegal board state for this ruleset: expected to_move '${turnState.turn.toLowerCase()}', got '${payload.board.to_move}'.`,
      )
    }

    const decision = chooseBotTurnDetailed(
      {
        moves: boardMap,
        moveHistory: [],
        turn: requestedTurn,
        placementsLeft: turnState.placementsLeft,
      },
      DEFAULT_BOT_TUNING,
      buildTimedSearchOptions(payload.time_limit ?? 0),
    )

    const legalPieces = decision.moves.slice(0, turnState.placementsLeft)
    const legalBoard = applyMove(boardMap, legalPieces, requestedTurn)
    if (!legalBoard.valid) {
      return error(res, 422, 'Bot produced an illegal move (occupied cell).')
    }

    const evalResult = evaluateBoardState(legalBoard.next, DEFAULT_BOT_TUNING)
    const heuristic = evalResult.objectiveForX
    const winIn = immediateWinInIfAny(legalBoard.next, requestedTurn)
    const evaluation = winIn === undefined
      ? { heuristic }
      : { heuristic, win_in: winIn }

    return writeJson(res, 200, {
      move: {
        pieces: legalPieces.map((piece) => ({ q: piece.q, r: piece.r })),
        evaluation,
      },
      meta: {
        mode: decision.stats.mode,
        elapsed_ms: Math.round(decision.stats.elapsedMs),
        nodes: decision.stats.nodesExpanded,
        playouts: decision.stats.playouts,
        depth_turns: decision.stats.maxDepthTurns,
        stop_reason: decision.stats.stopReason,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return error(res, 500, message)
  }
})

server.listen(port, () => {
  console.log(`bot-api listening on :${port}`)
})
