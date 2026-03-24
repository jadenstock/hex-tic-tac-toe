import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BotConfig, CliOptions, Entrant, JsonMap } from './types.ts'
import { mergeTuning } from './tuning.ts'

function seedPopulation(populationDir: string): void {
  const seeds: BotConfig[] = [
    {
      id: 'baseline-default',
      name: 'Baseline Default',
      notes: 'Exact default coefficients.',
      normalized: {
        defenseWeight: 0.5,
        candidateRadius: 5,
        topKFirstMoves: 6,
      },
    },
    {
      id: 'pressure-builder',
      name: 'Pressure Builder',
      notes: 'Leans into concurrent threat growth and forks.',
      normalized: {
        threatWeightsMul: [1, 1, 1, 1.12, 1.18, 1.12, 1],
        threatBreadthWeightsMul: [1, 1, 1, 1.2, 1.3, 1.3, 1],
        oneTurnForkBonusMul: 1.2,
        threat3ClusterBonusMul: 1.2,
        defenseWeight: 0.45,
        candidateRadius: 5,
        topKFirstMoves: 8,
      },
    },
    {
      id: 'defensive-net',
      name: 'Defensive Net',
      notes: 'More conservative and danger-aware.',
      normalized: {
        threatWeightsMul: [1, 1, 1, 0.95, 1.05, 1.1, 1],
        defenseWeight: 0.6,
        immediateDangerPenaltyMul: 1.25,
        oneTurnOverlapPenaltyMul: 1.15,
        candidateRadius: 5,
        topKFirstMoves: 6,
      },
    },
    {
      id: 'fast-light',
      name: 'Fast Light',
      notes: 'Compute-efficient baseline challenger.',
      normalized: {
        threatWeightsMul: [1, 1, 1, 0.95, 0.95, 1, 1],
        threatBreadthWeightsMul: [1, 1, 1, 0.9, 0.9, 0.9, 1],
        defenseWeight: 0.52,
        candidateRadius: 4,
        topKFirstMoves: 4,
      },
    },
  ]

  for (const seed of seeds) {
    const filePath = path.join(populationDir, `${seed.id}.json`)
    writeFileSync(filePath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')
  }
}

export function ensureSeedLog(logPath: string): void {
  const resolved = path.resolve(logPath)
  if (existsSync(resolved)) {
    return
  }

  mkdirSync(path.dirname(resolved), { recursive: true })
  writeFileSync(
    resolved,
    '# Bot Optimization Log\n\nTracks each tournament run, leaderboard, and qualitative mutation guidance.\n\n',
    'utf8',
  )
}

export function loadPopulation(opts: CliOptions): Entrant[] {
  const populationDir = path.resolve(opts.populationDir)
  if (!existsSync(populationDir)) {
    mkdirSync(populationDir, { recursive: true })
  }

  let files = readdirSync(populationDir)
    .filter((file) => file.endsWith('.json'))
    .sort()

  if (files.length === 0) {
    seedPopulation(populationDir)
    files = readdirSync(populationDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
  }

  if (files.length < 2) {
    throw new Error(`Need at least 2 population json files in ${populationDir}`)
  }

  const seenIds = new Set<string>()
  const entrants: Entrant[] = []

  for (const file of files) {
    const fullPath = path.join(populationDir, file)
    const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as JsonMap
    const id = String(parsed.id ?? '').trim()
    if (!id) throw new Error(`${file}: missing non-empty id`)
    if (seenIds.has(id)) throw new Error(`${file}: duplicate id '${id}'`)

    seenIds.add(id)

    const config: BotConfig = {
      id,
      name: parsed.name ? String(parsed.name) : undefined,
      notes: parsed.notes ? String(parsed.notes) : undefined,
      normalized: parsed.normalized as BotConfig['normalized'],
      rawTuning: parsed.rawTuning as BotConfig['rawTuning'],
    }

    entrants.push({
      id,
      name: config.name?.trim() || id,
      notes: config.notes,
      tuning: mergeTuning(config, opts),
      sourcePath: fullPath,
    })
  }

  return entrants
}
