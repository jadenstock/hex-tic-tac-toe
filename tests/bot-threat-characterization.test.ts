import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateBoardState } from '../src/bot/evaluation.ts'

test('evaluation still identifies one-turn wins after extending an open four', () => {
  const base = new Map<string, 'X' | 'O'>([
    ['0,0', 'X'],
    ['1,0', 'X'],
    ['2,0', 'X'],
    ['3,0', 'X'],
    ['10,10', 'O'],
    ['10,11', 'O'],
  ])
  const upgraded = new Map(base)
  upgraded.set('4,0', 'X')

  const before = evaluateBoardState(base)
  const after = evaluateBoardState(upgraded)

  assert.equal(before.xWillWinNextTurn, true)
  assert.equal(after.xWillWinNextTurn, true)
  assert.ok(after.xOneTurnWins > before.xOneTurnWins)
})

test('multiple independent 3-threat structures score higher than a single 3-threat lane', () => {
  const singleLane = new Map<string, 'X' | 'O'>([
    ['0,0', 'X'],
    ['1,0', 'X'],
    ['2,0', 'X'],
    ['10,10', 'O'],
    ['10,11', 'O'],
  ])
  const doubleLane = new Map<string, 'X' | 'O'>([
    ['0,0', 'X'],
    ['1,0', 'X'],
    ['2,0', 'X'],
    ['0,2', 'X'],
    ['1,2', 'X'],
    ['2,2', 'X'],
    ['10,10', 'O'],
    ['10,11', 'O'],
  ])

  const single = evaluateBoardState(singleLane)
  const doubled = evaluateBoardState(doubleLane)

  assert.equal(single.xThreats[3], 4)
  assert.equal(doubled.xThreats[3], 8)
  assert.ok(doubled.xScore > single.xScore)
  assert.ok(doubled.objectiveForX > single.objectiveForX)
})
