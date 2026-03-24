import type { CliOptions, Entrant, EntrantStats, MatchOutcome } from './types.ts'
import { playSingleGame } from './simulate.ts'

function initStats(entrant: Entrant): EntrantStats {
  return {
    id: entrant.id,
    name: entrant.name,
    sourcePath: entrant.sourcePath,
    wins: 0,
    losses: 0,
    draws: 0,
    points: 0,
    games: 0,
    turns: 0,
    placements: 0,
    totalDecisionMs: 0,
    avgDecisionMs: 0,
    avgPlacementDecisionMs: 0,
    complexityEstimate: entrant.tuning.candidateRadius * entrant.tuning.candidateRadius * Math.max(1, entrant.tuning.topKFirstMoves),
    score: 0,
  }
}

function applyGameStats(stats: Map<string, EntrantStats>, x: Entrant, o: Entrant, outcome: MatchOutcome): void {
  const xStats = stats.get(x.id)
  const oStats = stats.get(o.id)
  if (!xStats || !oStats) {
    throw new Error('missing stats map entries')
  }

  xStats.games += 1
  oStats.games += 1

  xStats.turns += outcome.xTurns
  oStats.turns += outcome.oTurns

  xStats.placements += outcome.xPlacements
  oStats.placements += outcome.oPlacements

  xStats.totalDecisionMs += outcome.xDecisionMs
  oStats.totalDecisionMs += outcome.oDecisionMs

  if (outcome.winner === 'X') {
    xStats.wins += 1
    oStats.losses += 1
    xStats.points += 1
  } else if (outcome.winner === 'O') {
    oStats.wins += 1
    xStats.losses += 1
    oStats.points += 1
  } else {
    xStats.draws += 1
    oStats.draws += 1
    xStats.points += 0.5
    oStats.points += 0.5
  }
}

export function runTournament(entrants: Entrant[], opts: CliOptions): { leaderboard: EntrantStats[]; gameCount: number } {
  const stats = new Map<string, EntrantStats>()
  for (const entrant of entrants) {
    stats.set(entrant.id, initStats(entrant))
  }

  let gameCount = 0
  const totalGames = opts.rounds * entrants.length * (entrants.length - 1)

  for (let round = 0; round < opts.rounds; round += 1) {
    for (let i = 0; i < entrants.length; i += 1) {
      for (let j = i + 1; j < entrants.length; j += 1) {
        const a = entrants[i]
        const b = entrants[j]

        const game1 = playSingleGame(a, b, opts.maxPlacements)
        applyGameStats(stats, a, b, game1)
        gameCount += 1
        if (gameCount % 20 === 0) {
          console.log(`Progress: ${gameCount}/${totalGames} games`)
        }

        const game2 = playSingleGame(b, a, opts.maxPlacements)
        applyGameStats(stats, b, a, game2)
        gameCount += 1
        if (gameCount % 20 === 0) {
          console.log(`Progress: ${gameCount}/${totalGames} games`)
        }
      }
    }
  }

  const leaderboard = [...stats.values()]

  for (const row of leaderboard) {
    row.avgDecisionMs = row.turns > 0 ? row.totalDecisionMs / row.turns : 0
    row.avgPlacementDecisionMs = row.placements > 0 ? row.totalDecisionMs / row.placements : 0
    row.score = row.points - opts.computePenaltyPerMs * row.avgDecisionMs
  }

  leaderboard.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.points !== b.points) return b.points - a.points
    if (a.wins !== b.wins) return b.wins - a.wins
    return a.avgDecisionMs - b.avgDecisionMs
  })

  return { leaderboard, gameCount }
}
