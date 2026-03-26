import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BotConfig, NormalizedConfig } from './lib/types.ts'

type Options = {
  populationDir: string
  count: number
  seed: number
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    populationDir: '.bot-opt/population',
    count: 8,
    seed: 42,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--population' && next) {
      opts.populationDir = next
      i += 1
      continue
    }
    if (arg === '--count' && next) {
      opts.count = Number(next)
      i += 1
      continue
    }
    if (arg === '--seed' && next) {
      opts.seed = Number(next)
      i += 1
      continue
    }
    if (arg === '--help') {
      console.log(`
Usage: node --experimental-strip-types bot-optimizer/generate-challengers.ts [options]

Options:
  --population <dir>    Population directory (default: .bot-opt/population)
  --count <n>           Number of challengers to add (default: 8)
  --seed <n>            RNG seed (default: 42)
`)
      process.exit(0)
    }
  }

  if (!Number.isFinite(opts.count) || opts.count < 1) throw new Error('count must be >= 1')
  if (!Number.isFinite(opts.seed)) throw new Error('seed must be finite')

  return opts
}

function lcg(seed: number): () => number {
  let state = Math.floor(seed) >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function mutateNormalized(base: NormalizedConfig, rand: () => number): NormalizedConfig {
  const next: NormalizedConfig = JSON.parse(JSON.stringify(base ?? {}))

  const tw = next.threatWeightsMul ?? [1, 1, 1, 1, 1, 1, 1]
  const tb = next.threatBreadthWeightsMul ?? [1, 1, 1, 1, 1, 1, 1]

  const jitter = () => 1 + (rand() * 0.36 - 0.18)

  for (const idx of [3, 4, 5]) {
    tw[idx] = clamp(tw[idx] * jitter(), 0.7, 1.45)
    tb[idx] = clamp(tb[idx] * jitter(), 0.6, 1.55)
  }

  next.threatWeightsMul = tw
  next.threatBreadthWeightsMul = tb

  next.defenseWeight = clamp((next.defenseWeight ?? 0.5) + (rand() * 0.18 - 0.09), 0.3, 0.75)
  next.immediateDangerPenaltyMul = clamp((next.immediateDangerPenaltyMul ?? 1) * jitter(), 0.65, 1.5)
  next.oneTurnWinBonusMul = clamp((next.oneTurnWinBonusMul ?? 1) * jitter(), 0.7, 1.45)
  next.oneTurnForkBonusMul = clamp((next.oneTurnForkBonusMul ?? 1) * jitter(), 0.7, 1.5)
  next.oneTurnOverlapPenaltyMul = clamp((next.oneTurnOverlapPenaltyMul ?? 1) * jitter(), 0.65, 1.5)
  next.threat3ClusterBonusMul = clamp((next.threat3ClusterBonusMul ?? 1) * jitter(), 0.65, 1.55)
  next.threat4ForkBonusMul = clamp((next.threat4ForkBonusMul ?? 1) * jitter(), 0.65, 1.55)
  next.threat5ForkBonusMul = clamp((next.threat5ForkBonusMul ?? 1) * jitter(), 0.65, 1.55)

  const radiusBase = next.candidateRadius ?? 5
  const topKBase = next.topKFirstMoves ?? 6
  next.candidateRadius = Math.round(clamp(radiusBase + (rand() * 2 - 1), 3, 6))
  next.topKFirstMoves = Math.round(clamp(topKBase + (rand() * 4 - 2), 3, 10))

  return next
}

function choosePhilosophy(n: NormalizedConfig): string {
  if ((n.defenseWeight ?? 0.5) >= 0.58) return 'defensive denial with high danger response'
  if ((n.oneTurnForkBonusMul ?? 1) >= 1.2) return 'fork pressure and dual-threat creation'
  if ((n.candidateRadius ?? 5) <= 4 && (n.topKFirstMoves ?? 6) <= 5) return 'compute-light tactical greed'
  if ((n.threat3ClusterBonusMul ?? 1) >= 1.2) return 'midgame threat clustering and compounding pressure'
  return 'balanced hybrid exploration around baseline'
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const populationDir = path.resolve(opts.populationDir)

  if (!existsSync(populationDir)) {
    mkdirSync(populationDir, { recursive: true })
  }

  const files = readdirSync(populationDir)
    .filter((name) => name.endsWith('.json'))
    .sort()

  if (files.length === 0) {
    throw new Error(`No seed configs found in ${populationDir}. Run bot optimizer once first.`)
  }

  const bases = files.map((name) => {
    const parsed = JSON.parse(readFileSync(path.join(populationDir, name), 'utf8')) as BotConfig
    return parsed
  })

  const rand = lcg(opts.seed)
  const created: string[] = []

  for (let i = 0; i < opts.count; i += 1) {
    const base = bases[Math.floor(rand() * bases.length)]
    const normalized = mutateNormalized(base.normalized ?? {}, rand)
    const id = `gen-${Date.now()}-${i.toString().padStart(2, '0')}`

    const candidate: BotConfig = {
      id,
      name: `Challenger ${i + 1}`,
      notes: `Generated from ${base.id}; philosophy: ${choosePhilosophy(normalized)}.`,
      normalized,
      rawTuning: undefined,
    }

    const outPath = path.join(populationDir, `${id}.json`)
    writeFileSync(outPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
    created.push(outPath)
  }

  console.log(`Created ${created.length} challengers in ${populationDir}`)
  for (const file of created) {
    console.log(`- ${path.basename(file)}`)
  }
}

main()
