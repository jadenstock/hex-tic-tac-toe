# Hexo Archive Dataset

This directory stores public archive collection outputs for `hexo.did.science`.

## Stage 1 Outputs

- `crawl-manifest.json`
  - snapshot metadata, progress, and fetch settings
- `games.jsonl`
  - one normalized metadata row per finished game, including source player ids/names
- `metadata.jsonl`
  - one anonymized, deduplicated metadata row per finished game
- `metadata-summary.json`
  - quick counts for the anonymized metadata file
- `summary.json`
  - aggregate counts and suggested subset sizes

## Stage 2 Replay Subsets

- `replay-subsets/<subset-name>/games.jsonl`
  - anonymized replay dataset rows
- `replay-subsets/<subset-name>/raw-replays/`
  - raw replay payloads from the source site
- `replay-subsets/<subset-name>/manifest.json`
  - progress and failures for the subset export
- `replay-subsets/<subset-name>/summary.json`
  - final exported counts for the subset
- `replay-subsets/<subset-name>/endgame-classification/classifications.jsonl`
  - replay rows annotated as `forced`, `blunder`, or `other`
- `replay-subsets/<subset-name>/endgame-classification/forced.jsonl`
  - subset of rows classified as forced wins
- `replay-subsets/<subset-name>/endgame-classification/blunder.jsonl`
  - subset of rows classified as blunder wins
- `replay-subsets/<subset-name>/endgame-classification/other.jsonl`
  - wins that were not one-turn forced or one-turn blunder cases by the bot metric
- `replay-subsets/<subset-name>/endgame-classification/summary.json`
  - aggregate counts for the endgame classification pass

## Notes

- Stage 1 stores metadata only. It does not fetch replay move histories.
- Use the script in `scripts/hexo-archive/fetch-archive-metadata.ts`.
- `metadata.jsonl` is the cleaner file to build downstream datasets from if you do not want player names or profile ids.
- `games.jsonl` is kept only as the richer metadata source with original player identifiers.
- `metadata.jsonl` should be treated as the canonical clean metadata file.

## Current Endgame Classification

For `replay-subsets/max-pre-elo-gt-1000-moves-gt-10`:

- total games classified: `237`
- `forced`: `37`
- `blunder`: `194`
- `other`: `6`

Reason breakdown:

- `forced`
  - `18` six-in-a-row
  - `17` surrender
  - `1` timeout
  - `1` disconnect
- `blunder`
  - `185` six-in-a-row
  - `6` surrender
  - `3` timeout
- `other`
  - `5` timeout
  - `1` disconnect

Classification rule:

- For board wins (`six-in-a-row`), classify from the board state at the start of the winner's final turn.
- For `surrender`, `timeout`, and `disconnect`, classify from the final board state.
- Use the bot's one-turn threat blocker burden:
  - `1` or `2` blockers required: `blunder`
  - `3+` blockers required: `forced`
  - `0` blockers required: `other`
