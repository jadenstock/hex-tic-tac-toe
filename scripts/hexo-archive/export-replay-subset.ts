import process from 'node:process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_BASE_URL = 'https://hexo.did.science'
const DEFAULT_METADATA_PATH = 'datasets/hexo-archive/games.jsonl'
const DEFAULT_OUTPUT_DIR = 'datasets/hexo-archive/replay-subsets'
const DEFAULT_DELAY_MS = 250
const DEFAULT_CONCURRENCY = 1
const DEFAULT_RETRY_COUNT = 4
const DEFAULT_RETRY_DELAY_MS = 1500

type MetadataPlayer = {
  playerId: string
  displayName: string
  profileId: string
  postGameElo: number | null
  eloChange: number | null
  preGameElo: number | null
  isGuestLike: boolean
}

type MetadataGame = {
  gameId: string
  sessionId: string
  visibility: string
  rated: boolean
  moveCount: number
  resultReason: string
  winnerPlayerId: string | null
  players: MetadataPlayer[]
}

type ReplayPlayerRaw = {
  playerId: string
  displayName: string
  profileId: string
  elo: number
  eloChange: number | null
}

type ReplayMoveRaw = {
  moveNumber: number
  playerId: string
  x: number
  y: number
  timestamp: number
}

type ReplayGameRaw = {
  id: string
  sessionId: string
  startedAt: number
  finishedAt: number
  players: ReplayPlayerRaw[]
  gameOptions: {
    visibility: string
    rated: boolean
  }
  moveCount: number
  gameResult: {
    winningPlayerId: string | null
    durationMs: number
    reason: string
  }
  moves: ReplayMoveRaw[]
}

type ExportPlayer = {
  slot: 'player_1' | 'player_2'
  preGameElo: number | null
}

type ExportMove = {
  moveNumber: number
  player: 'player_1' | 'player_2'
  x: number
  y: number
}

type ExportGame = {
  gameId: string
  sessionId: string
  rated: boolean
  visibility: string
  moveCount: number
  winner: 'player_1' | 'player_2' | null
  resultReason: string
  players: ExportPlayer[]
  moves: ExportMove[]
}

type ExportManifest = {
  version: 1
  subsetName: string
  baseUrl: string
  metadataPath: string
  outputDir: string
  startedAt: string
  updatedAt: string
  selection: {
    minMoveCountExclusive: number
    anyPlayerPreGameEloGreaterThan: number
  }
  totals: {
    candidateGames: number
    exportedGames: number
  }
  failedGameIds: string[]
}

type CliOptions = {
  baseUrl: string
  metadataPath: string
  outputDir: string
  delayMs: number
  concurrency: number
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: DEFAULT_BASE_URL,
    metadataPath: DEFAULT_METADATA_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    delayMs: DEFAULT_DELAY_MS,
    concurrency: DEFAULT_CONCURRENCY,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const nextValue = argv[index + 1]
    if (nextValue === undefined) {
      throw new Error(`Missing value for argument ${arg}`)
    }

    if (arg === '--base-url') {
      options.baseUrl = nextValue
      index += 1
      continue
    }

    if (arg === '--metadata-path') {
      options.metadataPath = nextValue
      index += 1
      continue
    }

    if (arg === '--out-dir') {
      options.outputDir = nextValue
      index += 1
      continue
    }

    if (arg === '--delay-ms') {
      options.delayMs = parseNonNegativeInt(nextValue, arg)
      index += 1
      continue
    }

    if (arg === '--concurrency') {
      options.concurrency = parsePositiveInt(nextValue, arg)
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function parseNonNegativeInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return parsed
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'hex-ttt-replay-export/1.0',
    },
  })

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

function replayUrl(baseUrl: string, gameId: string): string {
  return new URL(`/api/finished-games/${encodeURIComponent(gameId)}`, baseUrl).toString()
}

async function fetchReplayWithRetry(baseUrl: string, gameId: string): Promise<ReplayGameRaw> {
  let lastError: unknown = null

  for (let attempt = 1; attempt <= DEFAULT_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchJson<ReplayGameRaw>(replayUrl(baseUrl, gameId))
    } catch (error) {
      lastError = error
      if (error instanceof Error) {
        console.warn(`Replay ${gameId} attempt ${attempt} failed: ${error.message}`)
      }
      if (attempt < DEFAULT_RETRY_COUNT) {
        await sleep(DEFAULT_RETRY_DELAY_MS * attempt)
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Replay ${gameId} failed after ${DEFAULT_RETRY_COUNT} attempts`)
}

async function readMetadataGames(metadataPath: string): Promise<MetadataGame[]> {
  const text = await readFile(metadataPath, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MetadataGame)
}

function qualifies(game: MetadataGame): boolean {
  if (game.moveCount <= 10) {
    return false
  }

  const knownPreElos = game.players
    .map((player) => player.preGameElo)
    .filter((elo): elo is number => elo !== null)

  return knownPreElos.length > 0 && Math.max(...knownPreElos) > 1000
}

function anonymizedGame(replay: ReplayGameRaw): ExportGame {
  const slotByPlayerId = new Map<string, 'player_1' | 'player_2'>()
  const players: ExportPlayer[] = replay.players.slice(0, 2).map((player, index) => {
    const slot = index === 0 ? 'player_1' : 'player_2'
    slotByPlayerId.set(player.playerId, slot)
    const preGameElo =
      typeof player.elo === 'number' && typeof player.eloChange === 'number'
        ? player.elo - player.eloChange
        : null

    return {
      slot,
      preGameElo,
    }
  })

  return {
    gameId: replay.id,
    sessionId: replay.sessionId,
    rated: replay.gameOptions.rated,
    visibility: replay.gameOptions.visibility,
    moveCount: replay.moveCount,
    winner: replay.gameResult.winningPlayerId
      ? (slotByPlayerId.get(replay.gameResult.winningPlayerId) ?? null)
      : null,
    resultReason: replay.gameResult.reason,
    players,
    moves: replay.moves.map((move) => ({
      moveNumber: move.moveNumber,
      player: slotByPlayerId.get(move.playerId) ?? 'player_1',
      x: move.x,
      y: move.y,
    })),
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const metadataPath = path.resolve(options.metadataPath)
  const subsetName = 'max-pre-elo-gt-1000-moves-gt-10'
  const outputDir = path.resolve(options.outputDir, subsetName)
  const rawDir = path.join(outputDir, 'raw-replays')

  await mkdir(rawDir, { recursive: true })

  const metadataGames = await readMetadataGames(metadataPath)
  const candidates = metadataGames.filter(qualifies)

  const manifestPath = path.join(outputDir, 'manifest.json')
  const manifest: ExportManifest = {
    version: 1,
    subsetName,
    baseUrl: options.baseUrl,
    metadataPath,
    outputDir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    selection: {
      minMoveCountExclusive: 10,
      anyPlayerPreGameEloGreaterThan: 1000,
    },
    totals: {
      candidateGames: candidates.length,
      exportedGames: 0,
    },
    failedGameIds: [],
  }
  await writeJson(manifestPath, manifest)

  const exported: ExportGame[] = []
  let nextIndex = 0

  const workers = Array.from({ length: options.concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex
      nextIndex += 1

      const candidate = candidates[currentIndex]
      if (candidate === undefined) {
        return
      }

      try {
        const replay = await fetchReplayWithRetry(options.baseUrl, candidate.gameId)
        await writeJson(path.join(rawDir, `${candidate.gameId}.json`), replay)
        exported.push(anonymizedGame(replay))
        manifest.totals.exportedGames = exported.length
        manifest.updatedAt = new Date().toISOString()
        await writeJson(manifestPath, manifest)
        console.log(
          `Exported replay ${candidate.gameId} (${exported.length}/${candidates.length})`,
        )
      } catch (error) {
        manifest.failedGameIds.push(candidate.gameId)
        manifest.updatedAt = new Date().toISOString()
        await writeJson(manifestPath, manifest)
        if (error instanceof Error) {
          console.warn(`Replay ${candidate.gameId} failed permanently: ${error.message}`)
        }
      }

      if (options.delayMs > 0) {
        await sleep(options.delayMs)
      }
    }
  })

  await Promise.all(workers)

  exported.sort((left, right) => left.gameId.localeCompare(right.gameId))
  const jsonl = exported.map((game) => JSON.stringify(game)).join('\n')
  await writeFile(path.join(outputDir, 'games.jsonl'), jsonl.length > 0 ? `${jsonl}\n` : '', 'utf8')

  await writeJson(
    path.join(outputDir, 'summary.json'),
    {
      candidateGames: candidates.length,
      exportedGames: exported.length,
      failedGameIds: manifest.failedGameIds,
    },
  )

  console.log(`Wrote ${path.join(outputDir, 'games.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'summary.json')}`)
}

await main()
