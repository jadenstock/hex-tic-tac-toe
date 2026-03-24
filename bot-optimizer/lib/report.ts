import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BotTuning } from '../../src/bot/engine.ts'
import type { CliOptions, Entrant, EntrantStats, JsonMap } from './types.ts'

function summarizeParamDirection(top: Entrant[], all: Entrant[]): string[] {
  if (top.length === 0 || all.length === 0) return []

  const keys: Array<keyof BotTuning> = [
    'defenseWeight',
    'immediateDangerPenalty',
    'oneTurnWinBonus',
    'oneTurnForkBonus',
    'oneTurnOverlapPenalty',
    'threat3ClusterBonus',
    'threat4ForkBonus',
    'threat5ForkBonus',
    'candidateRadius',
    'topKFirstMoves',
  ]

  const insights: string[] = []

  for (const key of keys) {
    const topAvg = top.reduce((sum, entrant) => sum + entrant.tuning[key], 0) / top.length
    const allAvg = all.reduce((sum, entrant) => sum + entrant.tuning[key], 0) / all.length
    if (allAvg === 0) continue

    const ratio = topAvg / allAvg
    if (ratio >= 1.2) {
      insights.push(`${String(key)} trends higher in top bots (${topAvg.toFixed(2)} vs ${allAvg.toFixed(2)} population avg).`)
    } else if (ratio <= 0.8) {
      insights.push(`${String(key)} trends lower in top bots (${topAvg.toFixed(2)} vs ${allAvg.toFixed(2)} population avg).`)
    }
  }

  for (const idx of [3, 4, 5]) {
    const topAvg = top.reduce((sum, entrant) => sum + entrant.tuning.threatWeights[idx], 0) / top.length
    const allAvg = all.reduce((sum, entrant) => sum + entrant.tuning.threatWeights[idx], 0) / all.length
    if (allAvg === 0) continue

    const ratio = topAvg / allAvg
    if (ratio >= 1.2) insights.push(`threatWeights[${idx}] trends higher in top bots (${topAvg.toFixed(2)} vs ${allAvg.toFixed(2)}).`)
    if (ratio <= 0.8) insights.push(`threatWeights[${idx}] trends lower in top bots (${topAvg.toFixed(2)} vs ${allAvg.toFixed(2)}).`)
  }

  return insights.slice(0, 8)
}

export function writeResults(opts: CliOptions, entrants: Entrant[], leaderboard: EntrantStats[], gameCount: number): string {
  const result: JsonMap = {
    generatedAt: new Date().toISOString(),
    cli: opts,
    populationSize: entrants.length,
    gameCount,
    leaderboard,
    entrants: entrants.map((entrant) => ({
      id: entrant.id,
      name: entrant.name,
      notes: entrant.notes,
      sourcePath: entrant.sourcePath,
      tuning: entrant.tuning,
    })),
  }

  const resultsPath = path.resolve(opts.resultsPath)
  mkdirSync(path.dirname(resultsPath), { recursive: true })
  writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return resultsPath
}

export function appendOptimizationLog(opts: CliOptions, entrants: Entrant[], leaderboard: EntrantStats[], gameCount: number): string {
  const logPath = path.resolve(opts.logPath)
  mkdirSync(path.dirname(logPath), { recursive: true })

  const top = leaderboard.slice(0, Math.min(opts.topK, leaderboard.length))
  const topEntrants = top
    .map((row) => entrants.find((entry) => entry.id === row.id))
    .filter((entry): entry is Entrant => Boolean(entry))

  const insights = summarizeParamDirection(topEntrants, entrants)

  const lines: string[] = [
    `## Optimization Run ${new Date().toISOString()}`,
    '',
    `- Population: ${entrants.length}`,
    `- Games: ${gameCount}`,
    `- Rounds: ${opts.rounds}`,
    `- Max placements/game: ${opts.maxPlacements}`,
    `- Hard caps: radius <= ${opts.hardRadiusCap}, topK <= ${opts.hardTopKCap}`,
    `- Score function: points - (${opts.computePenaltyPerMs} * avgDecisionMs)`,
    '',
    '| Rank | Bot | Score | Points | W-L-D | Avg decision ms | Complexity |',
    '| --- | --- | ---: | ---: | --- | ---: | ---: |',
  ]

  for (let i = 0; i < top.length; i += 1) {
    const row = top[i]
    lines.push(
      `| ${i + 1} | ${row.name} (${row.id}) | ${row.score.toFixed(3)} | ${row.points.toFixed(1)} | ${row.wins}-${row.losses}-${row.draws} | ${row.avgDecisionMs.toFixed(2)} | ${row.complexityEstimate.toFixed(0)} |`,
    )
  }

  lines.push('', '### Qualitative Notes')
  if (insights.length === 0) {
    lines.push('- No strong parameter skew yet; expand exploration range and rerun.')
  } else {
    for (const insight of insights) lines.push(`- ${insight}`)
  }

  lines.push('', '### Manual Mutation Plan')
  lines.push(`- Keep top ${Math.min(opts.topK, leaderboard.length)} as anchors; create challengers around observed skews.`)
  lines.push('- Change only 2-4 parameters per challenger to keep attribution clear.')
  lines.push('- Keep at least one low-compute challenger in each generation for speed benchmarking.', '')

  appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8')
  return logPath
}

export function printTopSummary(leaderboard: EntrantStats[], n = 10): void {
  console.log('Top Bots:')
  for (let i = 0; i < Math.min(n, leaderboard.length); i += 1) {
    const row = leaderboard[i]
    console.log(
      `${i + 1}. ${row.name} (${row.id}) | score=${row.score.toFixed(3)} points=${row.points.toFixed(1)} W-L-D=${row.wins}-${row.losses}-${row.draws} avgMs=${row.avgDecisionMs.toFixed(2)} complexity=${row.complexityEstimate.toFixed(0)}`,
    )
  }
}
