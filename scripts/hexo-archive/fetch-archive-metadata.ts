import process from 'node:process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_BASE_URL = 'https://hexo.did.science'
const DEFAULT_OUTPUT_DIR = 'datasets/hexo-archive'
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_DELAY_MS = 300
const DEFAULT_CONCURRENCY = 2
const DEFAULT_RETRY_COUNT = 4
const DEFAULT_RETRY_DELAY_MS = 1500

type ArchivePlayerRaw = {
  playerId: string
  displayName: string
  profileId: string
  elo: number
  eloChange: number | null
}

type ArchiveTimeControlRaw = {
  mode: string
  mainTimeMs?: number
  incrementMs?: number
  turnTimeMs?: number
}

type ArchiveGameRaw = {
  id: string
  sessionId: string
  startedAt: number
  finishedAt: number
  players: ArchivePlayerRaw[]
  gameOptions: {
    visibility: string
    timeControl: ArchiveTimeControlRaw
    rated: boolean
  }
  moveCount: number
  gameResult: {
    winningPlayerId: string | null
    durationMs: number
    reason: string
  }
}

type ArchivePagination = {
  page: number
  pageSize: number
  totalGames: number
  totalMoves: number
  totalPages: number
  baseTimestamp: number
}

type ArchivePageData = {
  games: ArchiveGameRaw[]
  pagination: ArchivePagination
}

type StoredArchivePage = {
  page: number
  fetchedAt: string
  sourceUrl: string
  data: ArchivePageData
}

type NormalizedPlayer = {
  playerId: string
  displayName: string
  profileId: string
  postGameElo: number | null
  eloChange: number | null
  preGameElo: number | null
  isGuestLike: boolean
}

type NormalizedGame = {
  gameId: string
  sessionId: string
  sourcePage: number
  startedAt: number
  finishedAt: number
  finishedAtIso: string
  visibility: string
  rated: boolean
  moveCount: number
  resultReason: string
  winnerPlayerId: string | null
  durationMs: number
  timeControl: ArchiveTimeControlRaw
  players: NormalizedPlayer[]
  knownPreGameEloCount: number
  minKnownPreGameElo: number | null
  maxKnownPreGameElo: number | null
}

type CrawlManifest = {
  version: 1
  baseUrl: string
  outputDir: string
  rawPagesDir: string
  fetchedAt: string
  updatedAt: string
  delayMs: number
  concurrency: number
  totalPages: number
  totalGames: number
  totalMoves: number
  pageSize: number
  baseTimestamp: number
  pageLimit: number
  completedPages: number[]
}

type Summary = {
  snapshot: {
    totalPages: number
    totalGames: number
    totalMoves: number
    pageLimit: number
    baseTimestamp: number
  }
  collected: {
    storedPages: number
    normalizedGames: number
  }
  visibility: Record<string, number>
  rated: {
    rated: number
    unrated: number
  }
  moveCount: {
    min: number | null
    p25: number | null
    median: number | null
    p75: number | null
    p90: number | null
    max: number | null
  }
  knownPreGameElo: {
    gamesWithAnyKnownPreGameElo: number
    gamesWithBothKnownPreGameElos: number
  }
  candidateSubsets: Record<string, number>
}

type CliOptions = {
  baseUrl: string
  outputDir: string
  pageSize: number
  pageLimit: number | null
  delayMs: number
  concurrency: number
  refresh: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: DEFAULT_BASE_URL,
    outputDir: DEFAULT_OUTPUT_DIR,
    pageSize: DEFAULT_PAGE_SIZE,
    pageLimit: null,
    delayMs: DEFAULT_DELAY_MS,
    concurrency: DEFAULT_CONCURRENCY,
    refresh: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--refresh') {
      options.refresh = true
      continue
    }

    const nextValue = argv[index + 1]
    if (nextValue === undefined) {
      throw new Error(`Missing value for argument ${arg}`)
    }

    if (arg === '--base-url') {
      options.baseUrl = nextValue
      index += 1
      continue
    }

    if (arg === '--out-dir') {
      options.outputDir = nextValue
      index += 1
      continue
    }

    if (arg === '--page-limit') {
      options.pageLimit = parsePositiveInt(nextValue, arg)
      index += 1
      continue
    }

    if (arg === '--page-size') {
      options.pageSize = parsePositiveInt(nextValue, arg)
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

function finishedGamesApiUrl(
  baseUrl: string,
  page: number,
  pageSize: number,
  baseTimestamp: number | null,
): string {
  const url = new URL('/api/finished-games', baseUrl)
  url.searchParams.set('page', String(page))
  url.searchParams.set('pageSize', String(pageSize))
  if (baseTimestamp !== null) {
    url.searchParams.set('baseTimestamp', String(baseTimestamp))
  }
  return url.toString()
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'hex-ttt-archive-research/1.0',
    },
  })

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

async function writeFailureArtifact(
  failuresDir: string,
  page: number,
  attempt: number,
  payload: unknown,
): Promise<void> {
  const filePath = path.join(
    failuresDir,
    `page-${String(page).padStart(4, '0')}-attempt-${attempt}.json`,
  )
  await writeJson(filePath, payload)
}

function pageFilePath(rawPagesDir: string, page: number): string {
  return path.join(rawPagesDir, `page-${String(page).padStart(4, '0')}.json`)
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const text = await readFile(filePath, 'utf8')
  return JSON.parse(text) as T
}

function normalizeGame(game: ArchiveGameRaw, sourcePage: number): NormalizedGame {
  const players = game.players.map((player) => {
    const postGameElo = typeof player.elo === 'number' ? player.elo : null
    const eloChange = typeof player.eloChange === 'number' ? player.eloChange : null
    const preGameElo =
      postGameElo !== null && eloChange !== null ? postGameElo - eloChange : null

    return {
      playerId: player.playerId,
      displayName: player.displayName,
      profileId: player.profileId,
      postGameElo,
      eloChange,
      preGameElo,
      isGuestLike:
        player.displayName.startsWith('Guest ') ||
        player.profileId === player.playerId,
    }
  })

  const knownPreGameElos = players
    .map((player) => player.preGameElo)
    .filter((elo): elo is number => elo !== null)
    .sort((left, right) => left - right)

  return {
    gameId: game.id,
    sessionId: game.sessionId,
    sourcePage,
    startedAt: game.startedAt,
    finishedAt: game.finishedAt,
    finishedAtIso: new Date(game.finishedAt).toISOString(),
    visibility: game.gameOptions.visibility,
    rated: game.gameOptions.rated,
    moveCount: game.moveCount,
    resultReason: game.gameResult.reason,
    winnerPlayerId: game.gameResult.winningPlayerId,
    durationMs: game.gameResult.durationMs,
    timeControl: game.gameOptions.timeControl,
    players,
    knownPreGameEloCount: knownPreGameElos.length,
    minKnownPreGameElo: knownPreGameElos[0] ?? null,
    maxKnownPreGameElo: knownPreGameElos.at(-1) ?? null,
  }
}

function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) {
    return null
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * fraction)),
  )
  return sortedValues[index] ?? null
}

function buildSummary(games: NormalizedGame[], manifest: CrawlManifest): Summary {
  const visibility: Record<string, number> = {}
  let rated = 0
  let unrated = 0
  let gamesWithAnyKnownPreGameElo = 0
  let gamesWithBothKnownPreGameElos = 0

  const moveCounts = games.map((game) => game.moveCount).sort((left, right) => left - right)

  for (const game of games) {
    visibility[game.visibility] = (visibility[game.visibility] ?? 0) + 1

    if (game.rated) {
      rated += 1
    } else {
      unrated += 1
    }

    if (game.knownPreGameEloCount >= 1) {
      gamesWithAnyKnownPreGameElo += 1
    }
    if (game.knownPreGameEloCount >= 2) {
      gamesWithBothKnownPreGameElos += 1
    }
  }

  const countWhere = (predicate: (game: NormalizedGame) => boolean): number =>
    games.filter(predicate).length

  return {
    snapshot: {
      totalPages: manifest.totalPages,
      totalGames: manifest.totalGames,
      totalMoves: manifest.totalMoves,
      pageLimit: manifest.pageLimit,
      baseTimestamp: manifest.baseTimestamp,
    },
    collected: {
      storedPages: manifest.completedPages.length,
      normalizedGames: games.length,
    },
    visibility,
    rated: {
      rated,
      unrated,
    },
    moveCount: {
      min: moveCounts[0] ?? null,
      p25: percentile(moveCounts, 0.25),
      median: percentile(moveCounts, 0.5),
      p75: percentile(moveCounts, 0.75),
      p90: percentile(moveCounts, 0.9),
      max: moveCounts.at(-1) ?? null,
    },
    knownPreGameElo: {
      gamesWithAnyKnownPreGameElo,
      gamesWithBothKnownPreGameElos,
    },
    candidateSubsets: {
      publicOnly: countWhere((game) => game.visibility === 'public'),
      moveCountAtLeast20: countWhere((game) => game.moveCount >= 20),
      moveCountAtLeast25: countWhere((game) => game.moveCount >= 25),
      ratedOnly: countWhere((game) => game.rated),
      publicRatedMoveCount20: countWhere(
        (game) => game.visibility === 'public' && game.rated && game.moveCount >= 20,
      ),
      publicRatedMoveCount25: countWhere(
        (game) => game.visibility === 'public' && game.rated && game.moveCount >= 25,
      ),
      publicRatedMoveCount20MinPreGame900: countWhere(
        (game) =>
          game.visibility === 'public' &&
          game.rated &&
          game.moveCount >= 20 &&
          (game.minKnownPreGameElo ?? -1) >= 900,
      ),
      publicRatedMoveCount25MinPreGame1000: countWhere(
        (game) =>
          game.visibility === 'public' &&
          game.rated &&
          game.moveCount >= 25 &&
          (game.minKnownPreGameElo ?? -1) >= 1000,
      ),
      publicMoveCount20MaxPreGame1100: countWhere(
        (game) =>
          game.visibility === 'public' &&
          game.moveCount >= 20 &&
          (game.maxKnownPreGameElo ?? -1) >= 1100,
      ),
    },
  }
}

async function listCompletedPages(rawPagesDir: string): Promise<number[]> {
  const entries = await readdir(rawPagesDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(/^page-(\d+)\.json$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .filter((page) => Number.isInteger(page) && page > 0)
    .sort((left, right) => left - right)
}

async function rebuildDatasets(
  rawPagesDir: string,
  outputDir: string,
  manifest: CrawlManifest,
): Promise<void> {
  const pageNumbers = manifest.completedPages.filter((page) => page <= manifest.pageLimit)
  const gamesById = new Map<string, NormalizedGame>()

  for (const page of pageNumbers) {
    const stored = await readJsonFile<StoredArchivePage>(pageFilePath(rawPagesDir, page))
    for (const game of stored.data.games) {
      gamesById.set(game.id, normalizeGame(game, page))
    }
  }

  const games = [...gamesById.values()].sort((left, right) => right.finishedAt - left.finishedAt)
  const jsonl = games.map((game) => JSON.stringify(game)).join('\n')

  await writeFile(path.join(outputDir, 'games.jsonl'), jsonl.length > 0 ? `${jsonl}\n` : '', 'utf8')
  await writeJson(path.join(outputDir, 'summary.json'), buildSummary(games, manifest))
}

async function fetchArchivePage(
  baseUrl: string,
  page: number,
  pageSize: number,
  baseTimestamp: number,
  rawPagesDir: string,
  failuresDir: string,
): Promise<void> {
  const data = await fetchArchivePageDataWithRetry(
    baseUrl,
    page,
    pageSize,
    baseTimestamp,
    failuresDir,
  )
  const stored: StoredArchivePage = {
    page,
    fetchedAt: new Date().toISOString(),
    sourceUrl: finishedGamesApiUrl(baseUrl, page, pageSize, baseTimestamp),
    data,
  }
  await writeJson(pageFilePath(rawPagesDir, page), stored)
}

async function fetchArchivePageDataWithRetry(
  baseUrl: string,
  page: number,
  pageSize: number,
  baseTimestamp: number | null,
  failuresDir: string,
): Promise<ArchivePageData> {
  let lastError: unknown = null

  for (let attempt = 1; attempt <= DEFAULT_RETRY_COUNT; attempt += 1) {
    const url = finishedGamesApiUrl(baseUrl, page, pageSize, baseTimestamp)

    try {
      return await fetchJson<ArchivePageData>(url)
    } catch (error) {
      lastError = error

      if (error instanceof Error) {
        console.warn(`Page ${page} attempt ${attempt} failed: ${error.message}`)
      } else {
        console.warn(`Page ${page} attempt ${attempt} failed`)
      }

      try {
        const payload = await fetchJson<unknown>(url)
        await writeFailureArtifact(failuresDir, page, attempt, payload)
      } catch {
        // Ignore secondary fetch failures while preserving the main retry loop.
      }

      if (attempt < DEFAULT_RETRY_COUNT) {
        await sleep(DEFAULT_RETRY_DELAY_MS * attempt)
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Page ${page} failed after ${DEFAULT_RETRY_COUNT} attempts`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const outputDir = path.resolve(options.outputDir)
  const runKey = `page-size-${options.pageSize}`
  const rawPagesDir = path.join(outputDir, 'raw-pages', runKey)
  const failuresDir = path.join(outputDir, 'failures', runKey)
  const manifestPath = path.join(outputDir, 'crawl-manifest.json')

  await mkdir(rawPagesDir, { recursive: true })
  await mkdir(failuresDir, { recursive: true })

  let basePageData: ArchivePageData | null = null
  const existingPages = options.refresh ? [] : await listCompletedPages(rawPagesDir)

  if (existingPages.includes(1) && !options.refresh) {
    const stored = await readJsonFile<StoredArchivePage>(pageFilePath(rawPagesDir, 1))
    basePageData = stored.data
  } else {
    basePageData = await fetchArchivePageDataWithRetry(
      options.baseUrl,
      1,
      options.pageSize,
      null,
      failuresDir,
    )
    const bootstrapUrl = finishedGamesApiUrl(options.baseUrl, 1, options.pageSize, null)
    const stored: StoredArchivePage = {
      page: 1,
      fetchedAt: new Date().toISOString(),
      sourceUrl: bootstrapUrl,
      data: basePageData,
    }
    await writeJson(pageFilePath(rawPagesDir, 1), stored)
  }

  const pageLimit = Math.min(
    options.pageLimit ?? basePageData.pagination.totalPages,
    basePageData.pagination.totalPages,
  )

  const existingAfterBootstrap = options.refresh ? [1] : await listCompletedPages(rawPagesDir)
  const completedPages = existingAfterBootstrap.filter((page) => page <= pageLimit)

  const manifest: CrawlManifest = {
    version: 1,
    baseUrl: options.baseUrl,
    outputDir,
    rawPagesDir,
    fetchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    delayMs: options.delayMs,
    concurrency: options.concurrency,
    totalPages: basePageData.pagination.totalPages,
    totalGames: basePageData.pagination.totalGames,
    totalMoves: basePageData.pagination.totalMoves,
    pageSize: basePageData.pagination.pageSize,
    baseTimestamp: basePageData.pagination.baseTimestamp,
    pageLimit,
    completedPages,
  }

  await writeJson(manifestPath, manifest)

  const pagesToFetch: number[] = []
  for (let page = 1; page <= pageLimit; page += 1) {
    if (options.refresh || !completedPages.includes(page)) {
      pagesToFetch.push(page)
    }
  }

  if (pagesToFetch.length > 0) {
    let nextIndex = 0

    const workers = Array.from({ length: options.concurrency }, async () => {
      while (true) {
        const currentIndex = nextIndex
        nextIndex += 1

        const page = pagesToFetch[currentIndex]
        if (page === undefined) {
          return
        }

        await fetchArchivePage(
          options.baseUrl,
          page,
          manifest.pageSize,
          manifest.baseTimestamp,
          rawPagesDir,
          failuresDir,
        )

        if (!manifest.completedPages.includes(page)) {
          manifest.completedPages.push(page)
          manifest.completedPages.sort((left, right) => left - right)
        }
        manifest.updatedAt = new Date().toISOString()
        await writeJson(manifestPath, manifest)

        console.log(
          `Fetched page ${page}/${pageLimit} (${manifest.completedPages.length} stored pages)`,
        )

        if (options.delayMs > 0) {
          await sleep(options.delayMs)
        }
      }
    })

    await Promise.all(workers)
  }

  await rebuildDatasets(rawPagesDir, outputDir, manifest)

  console.log(`Wrote ${path.join(outputDir, 'games.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'summary.json')}`)
}

await main()
