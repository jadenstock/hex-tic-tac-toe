import process from 'node:process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createSearchBoard, boardToLiveState, makeBoardMove } from '../../src/bot/board.ts'
import { oneTurnBlockersRequired } from '../../src/bot/evaluation.ts'
import {
  buildTimedSearchOptions,
  chooseBotTurnDetailed,
  DEFAULT_BOT_TUNING,
  type Axial,
  type LiveLikeState,
  type Player,
} from '../../src/bot/engine.ts'

const DEFAULT_INPUT_PATH =
  'datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/endgame-classification/forced.jsonl'
const DEFAULT_TIME_LIMIT_SECONDS = 2

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

type ClassifiedForcedGame = {
  gameId: string
  sessionId: string
  rated: boolean
  visibility: string
  moveCount: number
  winner: 'player_1' | 'player_2' | null
  resultReason: string
  players: ReplayPlayer[]
  moves: ReplayMove[]
  classification: {
    label: 'forced'
    basis: 'winning-turn-start' | 'final-board'
    blockersRequired: number
    winnerMark: Player | null
    referencePlyCount: number
    note: string
  }
}

type EvaluatedGame = {
  gameId: string
  sessionId: string
  resultReason: string
  winner: 'player_1' | 'player_2'
  winnerMark: Player
  winnerPreGameElo: number | null
  loserPreGameElo: number | null
  classificationBasis: 'winning-turn-start' | 'final-board'
  blockersRequired: number
  referencePlyCount: number
  referenceState: {
    turn: Player
    placementsLeft: number
    moveCount: number
  }
  actualTurnMoves: Axial[]
  botPlannedMoves: Axial[]
  botExecutedMoves: Axial[]
  matchedMoves: number
  exactSetMatch: boolean
  tacticalSuccess: boolean
  tacticalOutcome: 'immediate-win' | 'forced-next-turn' | 'not-forced' | 'illegal-or-incomplete'
  postBotTurn: {
    executedMoveCount: number
    winner: Player | null
    blockersRequiredForWinnerNextTurn: number
  }
  botStats: {
    elapsedMs: number
    nodesExpanded: number
    playouts: number
    maxDepthTurns: number
    rootCandidates: number
    stopReason: string
  }
}

type SkippedGame = {
  gameId: string
  sessionId: string
  resultReason: string
  reason: string
}

type Summary = {
  inputPath: string
  timeLimitSeconds: number
  totalGames: number
  evaluatedGames: number
  skippedGames: number
  tacticalSuccesses: number
  tacticalSuccessRate: number
  tacticalOutcomes: Record<'immediate-win' | 'forced-next-turn' | 'not-forced' | 'illegal-or-incomplete', number>
  overlapCounts: Record<'0' | '1' | '2', number>
  exactSetMatches: number
  averageMatchedMoves: number
  averageBotElapsedMs: number
  averageBotNodesExpanded: number
  averageBotPlayouts: number
  byResultReason: Record<
    string,
    {
      total: number
      tacticalSuccesses: number
      overlapCounts: Record<'0' | '1' | '2', number>
    }
  >
  actualTurnMoveCounts: Record<'1' | '2', number>
}

type CliOptions = {
  inputPath: string
  timeLimitSeconds: number
  outputDir?: string
}

type TurnRecord = {
  player: Player
  plyStart: number
  state: LiveLikeState
  moves: Axial[]
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: DEFAULT_INPUT_PATH,
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
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

    if (arg === '--time-limit-seconds') {
      options.timeLimitSeconds = parsePositiveNumber(nextValue, arg)
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

function parsePositiveNumber(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return parsed
}

function slotToMark(slot: 'player_1' | 'player_2'): Player {
  return slot === 'player_1' ? 'X' : 'O'
}

function moveToAxial(move: ReplayMove): Axial {
  return { q: move.x, r: move.y }
}

function moveKey(move: Axial): string {
  return `${move.q},${move.r}`
}

function defaultOutputDir(inputPath: string, timeLimitSeconds: number): string {
  const timeLabel = timeLimitSeconds.toFixed(1).replace('.', 'p')
  return path.join(path.dirname(inputPath), `bot-turn-eval-${timeLabel}s`)
}

async function readGames(inputPath: string): Promise<ClassifiedForcedGame[]> {
  const text = await readFile(inputPath, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ClassifiedForcedGame)
}

function buildTurns(game: ClassifiedForcedGame): TurnRecord[] {
  const board = createSearchBoard({
    moves: new Map(),
    moveHistory: [],
    turn: 'X',
    placementsLeft: 1,
  })

  const turns: TurnRecord[] = []
  let currentTurn: TurnRecord | null = null

  for (const move of game.moves) {
    if (currentTurn === null) {
      currentTurn = {
        player: board.turn,
        plyStart: board.moves.size,
        state: boardToLiveState(board),
        moves: [],
      }
    }

    const mark = slotToMark(move.player)
    if (mark !== board.turn) {
      throw new Error(
        `Unexpected move order in ${game.gameId}: expected ${board.turn}, got ${mark} at move ${move.moveNumber}`,
      )
    }

    const undo = makeBoardMove(board, moveToAxial(move), mark)
    if (!undo) {
      throw new Error(`Illegal move in ${game.gameId} at move ${move.moveNumber}`)
    }

    currentTurn.moves.push(moveToAxial(move))

    if (undo.winner || board.placementsLeft === 2) {
      turns.push(currentTurn)
      currentTurn = null
    }
  }

  if (currentTurn !== null) {
    turns.push(currentTurn)
  }

  return turns
}

function countMatchedMoves(actualTurnMoves: Axial[], botMoves: Axial[]): number {
  const actualKeys = new Set(actualTurnMoves.map(moveKey))
  let matches = 0
  for (const move of botMoves) {
    if (actualKeys.has(moveKey(move))) {
      matches += 1
    }
  }
  return matches
}

function exactSetMatch(actualTurnMoves: Axial[], botMoves: Axial[]): boolean {
  if (actualTurnMoves.length !== botMoves.length) return false
  return countMatchedMoves(actualTurnMoves, botMoves) === actualTurnMoves.length
}

function winnerElos(game: ClassifiedForcedGame): { winnerPreGameElo: number | null; loserPreGameElo: number | null } {
  const winnerSlot = game.winner
  if (winnerSlot === null) return { winnerPreGameElo: null, loserPreGameElo: null }
  const winnerPlayer = game.players.find((player) => player.slot === winnerSlot) ?? null
  const loserPlayer = game.players.find((player) => player.slot !== winnerSlot) ?? null
  return {
    winnerPreGameElo: winnerPlayer?.preGameElo ?? null,
    loserPreGameElo: loserPlayer?.preGameElo ?? null,
  }
}

function assessBotTurn(state: LiveLikeState, winnerMark: Player, plannedMoves: Axial[]): {
  executedMoves: Axial[]
  tacticalSuccess: boolean
  tacticalOutcome: EvaluatedGame['tacticalOutcome']
  winner: Player | null
  blockersRequiredForWinnerNextTurn: number
} {
  const board = createSearchBoard(state)
  const executedMoves: Axial[] = []
  let winner: Player | null = null

  for (const move of plannedMoves.slice(0, state.placementsLeft)) {
    const undo = makeBoardMove(board, move, winnerMark)
    if (!undo) {
      return {
        executedMoves,
        tacticalSuccess: false,
        tacticalOutcome: 'illegal-or-incomplete',
        winner: null,
        blockersRequiredForWinnerNextTurn: 0,
      }
    }
    executedMoves.push(move)
    if (undo.winner === winnerMark) {
      winner = undo.winner
      return {
        executedMoves,
        tacticalSuccess: true,
        tacticalOutcome: 'immediate-win',
        winner,
        blockersRequiredForWinnerNextTurn: 0,
      }
    }
  }

  if (executedMoves.length < state.placementsLeft) {
    return {
      executedMoves,
      tacticalSuccess: false,
      tacticalOutcome: 'illegal-or-incomplete',
      winner: null,
      blockersRequiredForWinnerNextTurn: 0,
    }
  }

  const blockersRequiredForWinnerNextTurn = oneTurnBlockersRequired(board, winnerMark)
  return {
    executedMoves,
    tacticalSuccess: blockersRequiredForWinnerNextTurn >= 3,
    tacticalOutcome: blockersRequiredForWinnerNextTurn >= 3 ? 'forced-next-turn' : 'not-forced',
    winner: null,
    blockersRequiredForWinnerNextTurn,
  }
}

function evaluateGame(game: ClassifiedForcedGame, timeLimitSeconds: number): EvaluatedGame | SkippedGame {
  if (game.winner === null || game.classification.winnerMark === null) {
    return {
      gameId: game.gameId,
      sessionId: game.sessionId,
      resultReason: game.resultReason,
      reason: 'Game has no recorded winner.',
    }
  }

  const turns = buildTurns(game)
  if (turns.length === 0) {
    return {
      gameId: game.gameId,
      sessionId: game.sessionId,
      resultReason: game.resultReason,
      reason: 'Game has no playable turns.',
    }
  }

  const finalTurn = turns[turns.length - 1]
  const winnerMark = slotToMark(game.winner)
  if (finalTurn.player !== winnerMark) {
    return {
      gameId: game.gameId,
      sessionId: game.sessionId,
      resultReason: game.resultReason,
      reason: `Last recorded turn belongs to ${finalTurn.player}, not winner ${winnerMark}.`,
    }
  }

  const searchOptions = buildTimedSearchOptions(timeLimitSeconds)
  const decision = chooseBotTurnDetailed(finalTurn.state, DEFAULT_BOT_TUNING, searchOptions)
  const botPlannedMoves = decision.moves.slice(0, finalTurn.state.placementsLeft)
  const assessed = assessBotTurn(finalTurn.state, winnerMark, botPlannedMoves)
  const matchedMoves = countMatchedMoves(finalTurn.moves, assessed.executedMoves)
  const { winnerPreGameElo, loserPreGameElo } = winnerElos(game)

  return {
    gameId: game.gameId,
    sessionId: game.sessionId,
    resultReason: game.resultReason,
    winner: game.winner,
    winnerMark,
    winnerPreGameElo,
    loserPreGameElo,
    classificationBasis: game.classification.basis,
    blockersRequired: game.classification.blockersRequired,
    referencePlyCount: finalTurn.plyStart,
    referenceState: {
      turn: finalTurn.state.turn,
      placementsLeft: finalTurn.state.placementsLeft,
      moveCount: finalTurn.state.moves.size,
    },
    actualTurnMoves: finalTurn.moves,
    botPlannedMoves,
    botExecutedMoves: assessed.executedMoves,
    matchedMoves,
    exactSetMatch: exactSetMatch(finalTurn.moves, assessed.executedMoves),
    tacticalSuccess: assessed.tacticalSuccess,
    tacticalOutcome: assessed.tacticalOutcome,
    postBotTurn: {
      executedMoveCount: assessed.executedMoves.length,
      winner: assessed.winner,
      blockersRequiredForWinnerNextTurn: assessed.blockersRequiredForWinnerNextTurn,
    },
    botStats: {
      elapsedMs: decision.stats.elapsedMs,
      nodesExpanded: decision.stats.nodesExpanded,
      playouts: decision.stats.playouts,
      maxDepthTurns: decision.stats.maxDepthTurns,
      rootCandidates: decision.stats.rootCandidates,
      stopReason: decision.stats.stopReason,
    },
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeJsonl<T>(filePath: string, rows: T[]): Promise<void> {
  const text = rows.map((row) => JSON.stringify(row)).join('\n')
  await writeFile(filePath, text.length > 0 ? `${text}\n` : '', 'utf8')
}

function buildSummary(
  inputPath: string,
  timeLimitSeconds: number,
  evaluatedGames: EvaluatedGame[],
  skippedGames: SkippedGame[],
  totalGames: number,
): Summary {
  const summary: Summary = {
    inputPath,
    timeLimitSeconds,
    totalGames,
    evaluatedGames: evaluatedGames.length,
    skippedGames: skippedGames.length,
    tacticalSuccesses: 0,
    tacticalSuccessRate: 0,
    tacticalOutcomes: {
      'immediate-win': 0,
      'forced-next-turn': 0,
      'not-forced': 0,
      'illegal-or-incomplete': 0,
    },
    overlapCounts: { '0': 0, '1': 0, '2': 0 },
    exactSetMatches: 0,
    averageMatchedMoves: 0,
    averageBotElapsedMs: 0,
    averageBotNodesExpanded: 0,
    averageBotPlayouts: 0,
    byResultReason: {},
    actualTurnMoveCounts: { '1': 0, '2': 0 },
  }

  if (evaluatedGames.length === 0) return summary

  let matchedMovesSum = 0
  let elapsedSum = 0
  let nodesSum = 0
  let playoutsSum = 0

  for (const game of evaluatedGames) {
    const overlapKey = String(Math.min(2, Math.max(0, game.matchedMoves))) as '0' | '1' | '2'
    summary.tacticalOutcomes[game.tacticalOutcome] += 1
    if (game.tacticalSuccess) summary.tacticalSuccesses += 1
    summary.overlapCounts[overlapKey] += 1
    summary.actualTurnMoveCounts[String(Math.min(2, Math.max(1, game.actualTurnMoves.length))) as '1' | '2'] += 1
    if (game.exactSetMatch) summary.exactSetMatches += 1

    matchedMovesSum += game.matchedMoves
    elapsedSum += game.botStats.elapsedMs
    nodesSum += game.botStats.nodesExpanded
    playoutsSum += game.botStats.playouts

    const bucket = summary.byResultReason[game.resultReason] ?? {
      total: 0,
      tacticalSuccesses: 0,
      overlapCounts: { '0': 0, '1': 0, '2': 0 },
    }
    bucket.total += 1
    if (game.tacticalSuccess) bucket.tacticalSuccesses += 1
    bucket.overlapCounts[overlapKey] += 1
    summary.byResultReason[game.resultReason] = bucket
  }

  summary.tacticalSuccessRate = summary.tacticalSuccesses / evaluatedGames.length
  summary.averageMatchedMoves = matchedMovesSum / evaluatedGames.length
  summary.averageBotElapsedMs = elapsedSum / evaluatedGames.length
  summary.averageBotNodesExpanded = nodesSum / evaluatedGames.length
  summary.averageBotPlayouts = playoutsSum / evaluatedGames.length
  return summary
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const inputPath = path.resolve(options.inputPath)
  const outputDir = path.resolve(options.outputDir ?? defaultOutputDir(inputPath, options.timeLimitSeconds))

  await mkdir(outputDir, { recursive: true })

  const games = await readGames(inputPath)
  const evaluatedGames: EvaluatedGame[] = []
  const skippedGames: SkippedGame[] = []

  for (const game of games) {
    const result = evaluateGame(game, options.timeLimitSeconds)
    if ('tacticalSuccess' in result) {
      evaluatedGames.push(result)
      continue
    }
    skippedGames.push(result)
  }

  const summary = buildSummary(inputPath, options.timeLimitSeconds, evaluatedGames, skippedGames, games.length)

  await writeJsonl(path.join(outputDir, 'results.jsonl'), evaluatedGames)
  await writeJsonl(path.join(outputDir, 'skipped.jsonl'), skippedGames)
  await writeJson(path.join(outputDir, 'summary.json'), summary)

  console.log(`Wrote ${path.join(outputDir, 'results.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'skipped.jsonl')}`)
  console.log(`Wrote ${path.join(outputDir, 'summary.json')}`)
}

await main()
