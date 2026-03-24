import type { CliOptions } from './types.ts'

export function parseArgs(argv: string[]): CliOptions {
  const defaults: CliOptions = {
    populationDir: '.bot-opt/population',
    resultsPath: '.bot-opt/runs/latest.json',
    logPath: '.bot-opt/optimization-log.md',
    maxPlacements: 180,
    rounds: 1,
    topK: 4,
    opponents: 'all',
    hardRadiusCap: 6,
    hardTopKCap: 12,
    computePenaltyPerMs: 0,
  }

  const opts = { ...defaults }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--population' && next) {
      opts.populationDir = next
      i += 1
      continue
    }
    if (arg === '--results' && next) {
      opts.resultsPath = next
      i += 1
      continue
    }
    if (arg === '--log' && next) {
      opts.logPath = next
      i += 1
      continue
    }
    if (arg === '--max-placements' && next) {
      opts.maxPlacements = Number(next)
      i += 1
      continue
    }
    if (arg === '--rounds' && next) {
      opts.rounds = Number(next)
      i += 1
      continue
    }
    if (arg === '--top-k' && next) {
      opts.topK = Number(next)
      i += 1
      continue
    }
    if (arg === '--hard-radius-cap' && next) {
      opts.hardRadiusCap = Number(next)
      i += 1
      continue
    }
    if (arg === '--hard-topk-cap' && next) {
      opts.hardTopKCap = Number(next)
      i += 1
      continue
    }
    if (arg === '--compute-penalty-per-ms' && next) {
      opts.computePenaltyPerMs = Number(next)
      i += 1
      continue
    }
    if (arg === '--opponents' && next) {
      if (next !== 'all') {
        throw new Error(`Unsupported opponents mode '${next}'. Only 'all' is implemented.`)
      }
      opts.opponents = 'all'
      i += 1
      continue
    }

    if (arg === '--help') {
      console.log(`
Usage: npm run bot:opt -- [options]

Options:
  --population <dir>               Population JSON directory (default: .bot-opt/population)
  --results <file>                 Results JSON path (default: .bot-opt/runs/latest.json)
  --log <file>                     Optimization markdown log path (default: .bot-opt/optimization-log.md)
  --max-placements <n>             Hard draw cap by placements (default: 180)
  --rounds <n>                     Repeat pairings (default: 1)
  --top-k <n>                      Summary top-k (default: 4)
  --hard-radius-cap <n>            Hard max candidateRadius (default: 6)
  --hard-topk-cap <n>              Hard max topKFirstMoves (default: 12)
  --compute-penalty-per-ms <n>     Score penalty per avg decision ms (default: 0)
`)
      process.exit(0)
    }
  }

  if (!Number.isFinite(opts.maxPlacements) || opts.maxPlacements < 20) throw new Error('max-placements must be >= 20')
  if (!Number.isFinite(opts.rounds) || opts.rounds < 1) throw new Error('rounds must be >= 1')
  if (!Number.isFinite(opts.topK) || opts.topK < 1) throw new Error('top-k must be >= 1')
  if (!Number.isFinite(opts.hardRadiusCap) || opts.hardRadiusCap < 1) throw new Error('hard-radius-cap must be >= 1')
  if (!Number.isFinite(opts.hardTopKCap) || opts.hardTopKCap < 1) throw new Error('hard-topk-cap must be >= 1')
  if (!Number.isFinite(opts.computePenaltyPerMs) || opts.computePenaltyPerMs < 0) {
    throw new Error('compute-penalty-per-ms must be >= 0')
  }

  return opts
}
