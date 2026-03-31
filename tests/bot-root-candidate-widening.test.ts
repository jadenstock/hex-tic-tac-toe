import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createSearchBoard, boardToLiveState, makeBoardMove } from '../src/bot/board.ts'
import { buildTimedSearchOptions, chooseBotTurnDetailed, inspectBotCandidates } from '../src/bot/engine.ts'

test('single root candidate stops before spending the full search budget', () => {
  const decision = chooseBotTurnDetailed(
    {
      moves: new Map(),
      moveHistory: [],
      turn: 'X',
      placementsLeft: 1,
    },
    undefined,
    buildTimedSearchOptions(2),
  )

  assert.equal(decision.moves.length, 1)
  assert.equal(decision.stats.rootCandidates, 1)
  assert.equal(decision.stats.playouts, 0)
  assert.equal(decision.stats.stopReason, 'single_candidate')
})

test('root widening keeps the key variant line while the narrowed root gets one opponent reply per child', () => {
  const targetGameId = 'b0a50d0a-f8e5-4f39-84b7-2030ec70ab05'
  const replay = JSON.parse(
    readFileSync(
      `datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/raw-replays/${targetGameId}.json`,
      'utf8',
    ),
  ) as {
    players: Array<{ playerId: string }>
    moves: Array<{ playerId: string; x: number; y: number }>
  }
  const results = readFileSync(
    'datasets/hexo-archive/replay-subsets/max-pre-elo-gt-1000-moves-gt-10/endgame-classification/bot-turn-eval-2p0s/results.jsonl',
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { gameId: string; referenceState: { moveCount: number } })
  const result = results.find((entry) => entry.gameId === targetGameId)
  assert.ok(result)

  const board = createSearchBoard({
    moves: new Map(),
    moveHistory: [],
    turn: 'X',
    placementsLeft: 1,
  })
  const xPlayerId = replay.players[0].playerId

  for (const move of replay.moves) {
    if (board.moves.size >= result.referenceState.moveCount) break
    const player = move.playerId === xPlayerId ? 'X' : 'O'
    const undo = makeBoardMove(board, { q: move.x, r: move.y }, player)
    assert.ok(undo)
  }

  const snapshot = inspectBotCandidates(boardToLiveState(board), undefined, buildTimedSearchOptions(2))
  const lineKeys = snapshot.candidateLines.map((line) =>
    [...line]
      .sort((a, b) => (a.q !== b.q ? a.q - b.q : a.r - b.r))
      .map((cell) => `${cell.q},${cell.r}`)
      .join('|'),
  )
  const decision = chooseBotTurnDetailed(boardToLiveState(board), undefined, buildTimedSearchOptions(2))

  assert.equal(snapshot.candidateLines.length, 6)
  assert.ok(lineKeys.includes('-3,1|-1,-1'))
  assert.equal(decision.stats.rootCandidates, 6)
  assert.equal(decision.stats.debug?.rootVisitedChildren, 6)
  assert.equal(decision.stats.debug?.rootChildrenWithOpponentReplies, 6)
  assert.equal(decision.stats.debug?.rootAvgOpponentRepliesExplored, 1)
})
