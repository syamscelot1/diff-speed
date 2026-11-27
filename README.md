# diff-speed

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/syamscelot1/diff-speed/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/syamscelot1/diff-speed/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0: `solve.js` returns byte-identical
patches for every input, with far less CPU time. No dependencies, Node 22,
deterministic, each case answered alone.

## How it is faster

The reference spends its time in Myers's search, allocating a linked list of
path objects for every step. This implementation keeps the exact same search
— same diagonals, same tie-break (a deletion wins when a deletion and an
insertion reach the same point), same "first path to reach both ends" — but
runs it on integers instead of objects:

1. **Line interning.** Both texts are tokenized once into integer ids through
   a single shared `Map<string, number>`, so every comparison inside the
   search is an integer comparison, never a string one.
2. **Flat V snapshots.** The furthest-reaching x per diagonal is kept in one
   `Int32Array` per edit distance, instead of a path object per step. The
   script is recovered by walking those snapshots back, recomputing each
   step's move with the same rule the forward pass used.
3. **Sentinel snakes.** A sentinel id sits past each trimmed text's end, so
   the snake loop is a single integer comparison with no bounds checks, and
   diagonals past the edge read as "no path" with no bounds test either.
4. **Prefix/suffix trimming** on the id arrays before the search, and the
   patch built with array push + join, as in the reference.
5. **Patience bound.** Lines occurring exactly once in each text are matched
   in order by their longest increasing subsequence; those anchors plus the
   exact edit distance of each gap between them give an upper bound on the
   edit distance, and the search only visits diagonals that can still belong
   to a shortest path of that length.
6. **Tight anchor band.** The anchors' diagonals, interpolated linearly by
   edit depth, track the reference path's diagonal to within a few dozen
   lines, so the search first runs in a band a hundred and fifty diagonals
   wide around that interpolation — about a third of the diagonals of the
   wide band. The band is a heuristic only: if it ever fails to reach both
   ends, the search falls back to the wide band, then to the full search, so
   the answer is the reference's in every case.

On the practice set (4 cases, 20k–40k lines each, ~3,500–4,000 edits) this
runs about **12x faster** than the house baseline — see the benchmark in the
submission notes.

## Files

- `solve.js` — the entry: `run(input)` returns the `makefun-diff/1` patch.
- `main.ts` — the harness driver (the house baseline's driver, unchanged).
- `package.json`, `README.md`, `LICENSE` — this package.
