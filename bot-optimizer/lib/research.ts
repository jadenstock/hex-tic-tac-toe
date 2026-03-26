import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Entrant, EntrantStats } from './types.ts'

function defaultHypotheses(): string {
  return [
    '## Hypotheses To Test',
    '',
    '- [ ] Increasing `oneTurnForkBonusMul` with moderate `defenseWeight` creates stronger late-midgame conversion.',
    '- [ ] Lowering `candidateRadius` by 1 while increasing threat-4/5 weights improves win-rate-per-ms.',
    '- [ ] High `immediateDangerPenaltyMul` helps against fork-heavy opponents but may over-defend in neutral boards.',
    '- [ ] Slightly lower overlap penalty can help bots keep multi-line tension without tactical blunders.',
    '- [ ] Top bots should be stress-tested under tighter move caps to detect brittle long-horizon behavior.',
    '',
  ].join('\n')
}

function extractHypotheses(existing: string): string {
  const idx = existing.indexOf('## Hypotheses To Test')
  if (idx === -1) return defaultHypotheses()
  return existing.slice(idx).trimEnd() + '\n'
}

function inferPhilosophy(notes: string | undefined): string {
  if (!notes) return 'No explicit philosophy note yet.'
  return notes
}

export function updateResearchDoc(populationDir: string, entrants: Entrant[], leaderboard: EntrantStats[]): string {
  const docPath = path.resolve(path.dirname(populationDir), 'research.md')
  const previous = existsSync(docPath) ? readFileSync(docPath, 'utf8') : ''
  const hypotheses = extractHypotheses(previous)

  const botRows = entrants
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entrant) => {
      const philosophy = inferPhilosophy(entrant.notes).replace(/\|/g, '/')
      return `| ${entrant.id} | ${entrant.name} | ${philosophy} |`
    })

  const topRows = leaderboard.slice(0, Math.min(12, leaderboard.length)).map((row, idx) => {
    return `| ${idx + 1} | ${row.id} | ${row.points.toFixed(1)} | ${row.wins}-${row.losses}-${row.draws} | ${row.avgDecisionMs.toFixed(2)} | ${row.complexityEstimate.toFixed(0)} |`
  })

  const lines = [
    '# Bot Research Notebook',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Population directory: ${path.resolve(populationDir)}`,
    '',
    '## Bot Catalog',
    '',
    '| Bot ID | Name | Philosophy |',
    '| --- | --- | --- |',
    ...botRows,
    '',
    '## Latest Leaderboard Snapshot',
    '',
    '| Rank | Bot ID | Points | W-L-D | Avg decision ms | Complexity |',
    '| --- | --- | ---: | --- | ---: | ---: |',
    ...topRows,
    '',
    hypotheses,
  ]

  writeFileSync(docPath, `${lines.join('\n')}\n`, 'utf8')
  return docPath
}
