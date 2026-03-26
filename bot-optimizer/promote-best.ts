import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type BotTuning = {
  threatWeights: number[]
  threatBreadthWeights: number[]
  defenseWeight: number
  immediateDangerPenalty: number
  oneTurnWinBonus: number
  oneTurnForkBonus: number
  oneTurnOverlapPenalty: number
  threat3ClusterBonus: number
  threat4ForkBonus: number
  threat5ForkBonus: number
  candidateRadius: number
  topKFirstMoves: number
}

type ResultFile = {
  leaderboard?: Array<{ id: string }>
  entrants?: Array<{ id: string; tuning: BotTuning }>
}

function parseArgs(argv: string[]): { resultsPath: string; enginePath: string } {
  let resultsPath = '.bot-opt/runs/latest.json'
  let enginePath = 'src/bot/engine.ts'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--results' && next) {
      resultsPath = next
      i += 1
      continue
    }

    if (arg === '--engine' && next) {
      enginePath = next
      i += 1
      continue
    }

    if (arg === '--help') {
      console.log(`
Usage: npm run bot:opt:promote -- [options]

Options:
  --results <file>      Results json path (default: .bot-opt/runs/latest.json)
  --engine <file>       Engine file path (default: src/bot/engine.ts)
`)
      process.exit(0)
    }
  }

  return { resultsPath, enginePath }
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) {
    return n.toString()
  }
  return Number(n.toFixed(6)).toString()
}

function formatArray(values: number[]): string {
  return `[${values.map(formatNumber).join(', ')}]`
}

function formatDefaultBlock(tuning: BotTuning): string {
  return `export const DEFAULT_BOT_TUNING: BotTuning = {\n  threatWeights: ${formatArray(tuning.threatWeights)},\n  threatBreadthWeights: ${formatArray(tuning.threatBreadthWeights)},\n  defenseWeight: ${formatNumber(tuning.defenseWeight)},\n  immediateDangerPenalty: ${formatNumber(tuning.immediateDangerPenalty)},\n  oneTurnWinBonus: ${formatNumber(tuning.oneTurnWinBonus)},\n  oneTurnForkBonus: ${formatNumber(tuning.oneTurnForkBonus)},\n  oneTurnOverlapPenalty: ${formatNumber(tuning.oneTurnOverlapPenalty)},\n  threat3ClusterBonus: ${formatNumber(tuning.threat3ClusterBonus)},\n  threat4ForkBonus: ${formatNumber(tuning.threat4ForkBonus)},\n  threat5ForkBonus: ${formatNumber(tuning.threat5ForkBonus)},\n  candidateRadius: ${Math.round(tuning.candidateRadius)},\n  topKFirstMoves: ${Math.round(tuning.topKFirstMoves)},\n}`
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const resultPath = path.resolve(args.resultsPath)
  const enginePath = path.resolve(args.enginePath)

  const parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as ResultFile
  const top = parsed.leaderboard?.[0]
  if (!top) {
    throw new Error(`No leaderboard entries found in ${resultPath}`)
  }

  const entrant = parsed.entrants?.find((entry) => entry.id === top.id)
  if (!entrant) {
    throw new Error(`Top leaderboard id '${top.id}' not found in entrants array in ${resultPath}`)
  }

  const engineSource = readFileSync(enginePath, 'utf8')
  const replacementBlock = formatDefaultBlock(entrant.tuning)
  const nextSource = engineSource.replace(
    /export const DEFAULT_BOT_TUNING: BotTuning = \{[\s\S]*?\n\}/,
    replacementBlock,
  )

  if (nextSource === engineSource) {
    throw new Error('Could not find DEFAULT_BOT_TUNING block in engine file for replacement')
  }

  writeFileSync(enginePath, nextSource, 'utf8')

  console.log(`Promoted top bot '${top.id}' to DEFAULT_BOT_TUNING in ${enginePath}`)
}

main()
