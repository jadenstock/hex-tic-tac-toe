import path from 'node:path'
import { parseArgs } from './lib/cli.ts'
import { ensureSeedLog, loadPopulation } from './lib/population.ts'
import { appendOptimizationLog, printTopSummary, writeResults } from './lib/report.ts'
import { updateResearchDoc } from './lib/research.ts'
import { runTournament } from './lib/tournament.ts'

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const entrants = loadPopulation(opts)

  ensureSeedLog(opts.logPath)

  const { leaderboard, gameCount } = runTournament(entrants, opts)
  const resultsPath = writeResults(opts, entrants, leaderboard, gameCount)
  const logPath = appendOptimizationLog(opts, entrants, leaderboard, gameCount)
  const researchPath = updateResearchDoc(opts.populationDir, entrants, leaderboard)

  printTopSummary(leaderboard)
  console.log(`\nPopulation: ${entrants.length} | Games: ${gameCount}`)
  console.log(`Wrote results: ${resultsPath}`)
  console.log(`Appended log: ${path.resolve(logPath)}`)
  console.log(`Updated research doc: ${path.resolve(researchPath)}`)
}

main()
