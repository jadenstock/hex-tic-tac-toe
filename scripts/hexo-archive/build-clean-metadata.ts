import process from 'node:process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_INPUT_PATH = 'datasets/hexo-archive/games.jsonl'
const DEFAULT_OUTPUT_PATH = 'datasets/hexo-archive/metadata.jsonl'
const DEFAULT_SUMMARY_PATH = 'datasets/hexo-archive/metadata-summary.json'

type InputPlayer = {
  playerId: string
  postGameElo: number | null
  eloChange: number | null
  preGameElo: number | null
}

type InputGame = {
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
  players: InputPlayer[]
  knownPreGameEloCount: number
  minKnownPreGameElo: number | null
  maxKnownPreGameElo: number | null
}

type OutputPlayer = {
  slot: 'player_1' | 'player_2'
  preGameElo: number | null
  postGameElo: number | null
  eloChange: number | null
}

type OutputGame = {
  gameId: string
  sessionId: string
  sourcePage: number
  startedAt: number
  finishedAt: number
  finishedAtIso: string
  durationMs: number
  visibility: string
  rated: boolean
  moveCount: number
  resultReason: string
  winner: 'player_1' | 'player_2' | null
  players: OutputPlayer[]
  knownPreGameEloCount: number
  minKnownPreGameElo: number | null
  maxKnownPreGameElo: number | null
}

type Summary = {
  inputGames: number
  outputGames: number
  ratedGames: number
  publicGames: number
  privateGames: number
}

type CliOptions = {
  inputPath: string
  outputPath: string
  summaryPath: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: DEFAULT_INPUT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    summaryPath: DEFAULT_SUMMARY_PATH,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const nextValue = argv[index + 1]
    if (nextValue === undefined) {
      throw new Error(`Missing value for argument ${arg}`)
    }

    if (arg === '--input') {
      options.inputPath = nextValue
      index += 1
      continue
    }

    if (arg === '--output') {
      options.outputPath = nextValue
      index += 1
      continue
    }

    if (arg === '--summary') {
      options.summaryPath = nextValue
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readGames(inputPath: string): Promise<InputGame[]> {
  const text = await readFile(inputPath, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InputGame)
}

function cleanGame(game: InputGame): OutputGame {
  const slotByPlayerId = new Map<string, 'player_1' | 'player_2'>()
  const players = game.players.slice(0, 2).map((player, index) => {
    const slot = index === 0 ? 'player_1' : 'player_2'
    slotByPlayerId.set(player.playerId, slot)
    return {
      slot,
      preGameElo: player.preGameElo,
      postGameElo: player.postGameElo,
      eloChange: player.eloChange,
    }
  })

  return {
    gameId: game.gameId,
    sessionId: game.sessionId,
    sourcePage: game.sourcePage,
    startedAt: game.startedAt,
    finishedAt: game.finishedAt,
    finishedAtIso: game.finishedAtIso,
    durationMs: game.durationMs,
    visibility: game.visibility,
    rated: game.rated,
    moveCount: game.moveCount,
    resultReason: game.resultReason,
    winner: game.winnerPlayerId ? (slotByPlayerId.get(game.winnerPlayerId) ?? null) : null,
    players,
    knownPreGameEloCount: game.knownPreGameEloCount,
    minKnownPreGameElo: game.minKnownPreGameElo,
    maxKnownPreGameElo: game.maxKnownPreGameElo,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const inputPath = path.resolve(options.inputPath)
  const outputPath = path.resolve(options.outputPath)
  const summaryPath = path.resolve(options.summaryPath)

  await mkdir(path.dirname(outputPath), { recursive: true })

  const inputGames = await readGames(inputPath)
  const uniqueGames = new Map<string, InputGame>()
  for (const game of inputGames) {
    uniqueGames.set(game.gameId, game)
  }

  const cleanedGames = [...uniqueGames.values()]
    .sort((left, right) => right.finishedAt - left.finishedAt)
    .map(cleanGame)

  const jsonl = cleanedGames.map((game) => JSON.stringify(game)).join('\n')
  await writeFile(outputPath, jsonl.length > 0 ? `${jsonl}\n` : '', 'utf8')

  const summary: Summary = {
    inputGames: inputGames.length,
    outputGames: cleanedGames.length,
    ratedGames: cleanedGames.filter((game) => game.rated).length,
    publicGames: cleanedGames.filter((game) => game.visibility === 'public').length,
    privateGames: cleanedGames.filter((game) => game.visibility === 'private').length,
  }
  await writeJson(summaryPath, summary)

  console.log(`Wrote ${outputPath}`)
  console.log(`Wrote ${summaryPath}`)
}

await main()
