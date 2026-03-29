import process from 'node:process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  boardToLiveState,
  createSearchBoard,
  makeBoardMove,
  type SearchBoard,
} from '../../src/bot/board.ts'
import { oneTurnBlockersRequired } from '../../src/bot/evaluation.ts'
import type { Player } from '../../src/bot/types.ts'

const DEFAULT_INPUT_PATH =
  'datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/games.jsonl'
const DEFAULT_OUTPUT_DIR =
  'datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/endgame-classification'

type ReplayPlayer = {
  slot: 'player_1' | 'player_2'
  preGameElo: number | null
}

type ReplayMove = {
  moveNumber: number
  player: 'player_1' | 'player_2'
  x: number
  y: number
}

type ReplayGame = {
  gameId: string
  sessionId: string
  rated: boolean
  visibility: string
  moveCount: number
  winner: 'player_1' | 'player_2' | null
  resultReason: string
  players: ReplayPlayer[]
  moves: ReplayMove[]
}

type ClassificationLabel = 'forced' | 'blunder' | 'other'
type ClassificationBasis = 'winning-turn-start' | 'final-board'

type ClassifiedGame = ReplayGame & {
  classification: {
    label: ClassificationLabel
    basis: ClassificationBasis
    blockersRequired: number
    winnerMark: Player | null
    referencePlyCount: number
    note: string
  }
}

type Summary = {
  totalGames: number
  forced: number
  blunder: number
  other: number
  byResultReason: Record<string, number>
}

type CliOptions = {
  inputPath: string
  outputDir: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: DEFAULT_INPUT_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
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

    if (arg === '--out-dir') {
      options.outputDir = nextValue
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

async function readReplayGames(inputPath: string): Promise<ReplayGame[]> {
  const text = await readFile(inputPath, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReplayGame)
}

function cloneBoard(board: SearchBoard): SearchBoard {
  return createSearchBoard(boardToLiveState(board))
}

function startOfTurn(board: SearchBoard): boolean {
  return board.moves.size === 0 || board.placementsLeft === 2
}

function slotToMark(slot: 'player_1' | 'player_2'): Player {
  return slot === 'player_1' ? 'X' : 'O'
}

function classifyFromBlockers(
  blockersRequired: number,
  basis: ClassificationBasis,
  winnerMark: Player | null,
  referencePlyCount: number,
  note: string,
  game: ReplayGame,
): ClassifiedGame {
  let label: ClassificationLabel = 'other'
  if (blockersRequired >= 3) {
    label = 'forced'
  } else if (blockersRequired >= 1) {
    label = 'blunder'
  }

  return {
    ...game,
    classification: {
      label,
      basis,
      blockersRequired,
      winnerMark,
      referencePlyCount,
      note,
    },
  }
}

function classifyReplay(game: ReplayGame): ClassifiedGame {
  const winnerMark = game.winner ? slotToMark(game.winner) : null

  if (winnerMark === null) {
    return classifyFromBlockers(
      0,
      'final-board',
      null,
      0,
      'Game has no winner in replay metadata.',
      game,
    )
  }

  const board = createSearchBoard({
    moves: new Map(),
    moveHistory: [],
    turn: 'X',
    placementsLeft: 1,
  })

  let winningTurnStart: SearchBoard | null = null

  for (const move of game.moves) {
    if (startOfTurn(board) && slotToMark(move.player) === board.turn) {
      winningTurnStart = cloneBoard(board)
    }

    const mark = slotToMark(move.player)
    if (mark !== board.turn) {
      throw new Error(
        `Unexpected move order in ${game.gameId}: expected ${board.turn}, got ${mark} at move ${move.moveNumber}`,
      )
    }

    const undo = makeBoardMove(board, { q: move.x, r: move.y }, mark)
    if (!undo) {
      throw new Error(`Illegal move in ${game.gameId} at move ${move.moveNumber}`)
    }

    if (undo.winner) {
      if (winningTurnStart === null) {
        throw new Error(`Missing winning turn snapshot for ${game.gameId}`)
      }
      const blockersRequired = oneTurnBlockersRequired(winningTurnStart, winnerMark)
      return classifyFromBlockers(
        blockersRequired,
        'winning-turn-start',
        winnerMark,
        winningTurnStart.moves.size,
        "Classified from the board state at the start of the winner's final turn.",
        game,
      )
    }
  }

  const blockersRequired = oneTurnBlockersRequired(board, winnerMark)
  return classifyFromBlockers(
    blockersRequired,
    'final-board',
    winnerMark,
    board.moves.size,
    'No board win occurred in the replay; classified from the final board state.',
    game,
  )
}

function buildSummary(games: ClassifiedGame[]): Summary {
  const summary: Summary = {
    totalGames: games.length,
    forced: 0,
    blunder: 0,
    other: 0,
    byResultReason: {},
  }

  for (const game of games) {
    summary[game.classification.label] += 1
    summary.byResultReason[game.resultReason] = (summary.byResultReason[game.resultReason] ?? 0) + 1
  }

  return summary
}

async function writeJsonl<T>(filePath: string, rows: T[]): Promise<void> {
  const text = rows.map((row) => JSON.stringify(row)).join('\n')
  await writeFile(filePath, text.length > 0 ? `${text}\n` : '', 'utf8')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const inputPath = path.resolve(options.inputPath)
  const outputDir = path.resolve(options.outputDir)

  await mkdir(outputDir, { recursive: true })

  const games = await readReplayGames(inputPath)
  const classified = games.map(classifyReplay)

  const forced = classified.filter((game) => game.classification.label === 'forced')
  const blunder = classified.filter((game) => game.classification.label === 'blunder')
  const other = classified.filter((game) => game.classification.label === 'other')

  await writeJsonl(path.join(outputDir, 'classifications.jsonl'), classified)
  await writeJsonl(path.join(outputDir, 'forced.jsonl'), forced)
  await writeJsonl(path.join(outputDir, 'blunder.jsonl'), blunder)
  await writeJsonl(path.join(outputDir, 'other.jsonl'), other)
  await writeJson(path.join(outputDir, 'summary.json'), buildSummary(classified))

  console.log(`Wrote ${path.join(outputDir, 'classifications.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'forced.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'blunder.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'other.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'summary.json')}`)
}

await main()
