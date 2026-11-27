// A fast drop-in for makefun-diff 1.0.0.
//
// The rule, restated from the house baseline's own header: a text is cut after
// every "\n" (a "\r" stays part of its line); a last line with no "\n" is a
// line too; the empty text has no lines. The common prefix of lines is kept,
// then the common suffix of what is left; between them Myers's greedy search
// runs, keeping on each diagonal the path furthest into the old text, taking
// the deletion when a deletion and an insertion reach the same point, never
// moving past either text's end and pruning no edge diagonal, following every
// run of equal lines as far as it goes; the first path to reach both ends is
// the script. The patch is "makefun-diff/1 old=N new=M hunks=H deleted=D
// inserted=I", then per hunk "@ os ol ns nl" and one line per line it covers
// ("=" kept, "-" deleted, "+" inserted), deletions before insertions in each
// change run, up to 3 kept lines before and after a run, two runs at most 6
// kept lines apart sharing a hunk; a line with no final newline is written
// with one and followed by "%". Identical texts are the first line alone.
//
// Speed comes from five changes over the reference's shape:
//  - lines are interned to small integer ids once (one Map<string, number>
//    shared by both texts), so every comparison in the search is an integer
//    comparison, never a string one;
//  - the search keeps its furthest-reaching x per diagonal in flat Int32Array
//    snapshots, one per edit distance, instead of a linked list of path
//    objects allocated per step; the script is recovered by walking those
//    snapshots back, recomputing each step's move with the same rule
//    (deletion wins ties), so the script is the reference's, bit for bit;
//  - the snake runs on sentinel ids placed past each trimmed text's end, so
//    its loop is a single integer comparison with no bounds checks, and a
//    diagonal past the edge reads as "no path" with no bounds test either.
//    Snapshots store x+1, so a fresh (zeroed) array already marks every
//    diagonal "no path" and no fill pass is needed;
//  - a patience anchor set (lines occurring exactly once in each text,
//    matched in order by their longest increasing subsequence) plus the exact
//    edit distance of each gap between anchors gives an upper bound on the
//    edit distance, and the search only visits diagonals that can still
//    belong to a shortest path of that length;
//  - the search is first run in a tight band around the anchors' diagonal:
//    the anchors' diagonals, interpolated linearly by edit depth, track the
//    reference path's diagonal to within a few dozen lines on these texts, so
//    a band a hundred and fifty diagonals wide around that interpolation
//    holds the path while visiting a third of the diagonals. The band is a
//    heuristic only: if it ever fails to reach both ends the search falls
//    back to the wide band, then to the full search, so the answer is the
//    reference's in every case.

const KEEP = 0;
const DEL = 1;
const INS = 2;

// The tight band's half-width in diagonals. The reference path's diagonal
// stays within a few dozen of the anchors' interpolation on these texts; a
// hundred and fifty leaves several times that margin, and the margin grows
// with the largest gap's edit distance (see run), so a wider excursion in a
// big moved block still fits. If it ever does not, the fallbacks below
// recover the reference's answer.
const BAND_HALF_WIDTH = 150;

/** Split `text` into its lines (each with its "\n", the last one without when
 *  the text does not end in one) and the integer id of each line in `map`.
 *  The same line in both texts gets the same id, so ids compare exactly. */
function tokenize(text, map) {
  const lines = [];
  const ids = [];
  let start = 0;
  for (;;) {
    const cut = text.indexOf('\n', start);
    if (cut === -1) break;
    const line = text.slice(start, cut + 1);
    lines.push(line);
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids.push(id);
    start = cut + 1;
  }
  if (start < text.length) {
    const line = text.slice(start);
    lines.push(line);
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids.push(id);
  }
  return { lines, ids: Int32Array.from(ids) };
}

/** The patience anchors of A (n lines) into B (m lines) and the exact edit
 *  distance of each gap between them. Lines occurring exactly once in each
 *  text are matched in order by their longest increasing subsequence; those
 *  anchors plus the exact edit distance of each gap between them (by a small
 *  LCS dynamic program) form a valid script, so their sum is an upper bound
 *  on the true distance. `idCount` is the number of distinct ids; `dp` is a
 *  reusable scratch row of length m+1. Returns the bound, the anchors
 *  (ancA, ancB), the edit depth at each anchor (ancDepth, the edits in the
 *  gaps before it), and the largest gap's edit distance (maxGap). */
function anchorData(A, B, n, m, idCount, dp) {
  const cntA = new Int32Array(idCount);
  const cntB = new Int32Array(idCount);
  for (let i = 0; i < n; i++) cntA[A[i]]++;
  for (let j = 0; j < m; j++) cntB[B[j]]++;
  const posB = new Int32Array(idCount).fill(-1);
  for (let j = 0; j < m; j++) if (cntB[B[j]] === 1) posB[B[j]] = j;
  // The pairs (old position, new position) of lines unique in both, in old order.
  const pA = new Int32Array(n);
  const pB = new Int32Array(n);
  let U = 0;
  for (let i = 0; i < n; i++) {
    const id = A[i];
    if (cntA[id] === 1 && posB[id] !== -1) {
      pA[U] = i;
      pB[U] = posB[id];
      U++;
    }
  }
  // Longest increasing subsequence of the new positions (patience, with
  // parent pointers to recover the anchors).
  const tails = new Int32Array(U);
  const tailIdx = new Int32Array(U);
  const prev = new Int32Array(U);
  let len = 0;
  for (let i = 0; i < U; i++) {
    const v = pB[i];
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    if (lo === len) len++;
  }
  const ancA = new Int32Array(len);
  const ancB = new Int32Array(len);
  let idx = len > 0 ? tailIdx[len - 1] : -1;
  let w = len;
  while (idx !== -1) {
    w--;
    ancA[w] = pA[idx];
    ancB[w] = pB[idx];
    idx = prev[idx];
  }
  // The exact edit distance of each gap between anchors (and the ends).
  const gapD = new Int32Array(len + 1);
  let bound = 0;
  let maxGap = 0;
  let pa = -1;
  let pb = -1;
  for (let t = 0; t <= len; t++) {
    const na = t < len ? ancA[t] : n;
    const nb = t < len ? ancB[t] : m;
    const gn = na - pa - 1;
    const gm = nb - pb - 1;
    let gd = 0;
    if (gn > 0 || gm > 0) {
      if (gn === 0) gd = gm;
      else if (gm === 0) gd = gn;
      else {
        let same = gn === gm;
        if (same) {
          for (let i = 0; i < gn; i++) {
            if (A[pa + 1 + i] !== B[pb + 1 + i]) {
              same = false;
              break;
            }
          }
        }
        if (!same) {
          // LCS of the gap by a single-row dynamic program; its edit
          // distance is gn + gm - 2 * LCS.
          dp.fill(0, 0, gm + 1);
          for (let i = 0; i < gn; i++) {
            let diag = 0;
            const av = A[pa + 1 + i];
            for (let j = 0; j < gm; j++) {
              const tmp = dp[j + 1];
              if (av === B[pb + 1 + j]) dp[j + 1] = diag + 1;
              else if (dp[j] > dp[j + 1]) dp[j + 1] = dp[j];
              diag = tmp;
            }
          }
          gd = gn + gm - 2 * dp[gm];
        }
      }
    }
    gapD[t] = gd;
    if (gd > maxGap) maxGap = gd;
    bound += gd;
    pa = na;
    pb = nb;
  }
  // The edit depth at each anchor: the edits in the gaps before it.
  const ancDepth = new Int32Array(len + 1);
  let cum = 0;
  for (let t = 0; t < len; t++) {
    cum += gapD[t];
    ancDepth[t] = cum;
  }
  ancDepth[len] = bound;
  return { bound, ancA, ancB, ancDepth, len, maxGap };
}

/** The anchors' diagonal, interpolated linearly by edit depth: an array of
 *  length cap+1, kInterp[d] the diagonal the anchored script is on after d
 *  edits. The points are (0, 0), each anchor's (depth, old-new), and
 *  (cap, n-m). */
function anchorDiagonal(ad, cap, kStar) {
  const len = ad.len;
  const pD = new Int32Array(len + 2);
  const pK = new Int32Array(len + 2);
  pD[0] = 0;
  pK[0] = 0;
  for (let t = 0; t < len; t++) {
    pD[t + 1] = ad.ancDepth[t];
    pK[t + 1] = ad.ancA[t] - ad.ancB[t];
  }
  pD[len + 1] = cap;
  pK[len + 1] = kStar;
  const kInterp = new Int32Array(cap + 1);
  let s = 0;
  for (let d = 0; d <= cap; d++) {
    while (s + 1 <= len + 1 && pD[s + 1] <= d) s++;
    if (s + 1 > len + 1) {
      kInterp[d] = pK[s];
    } else {
      const d0 = pD[s];
      const d1 = pD[s + 1];
      const k0 = pK[s];
      const k1 = pK[s + 1];
      kInterp[d] = d1 === d0 ? k0 : k0 + Math.floor(((k1 - k0) * (d - d0)) / (d1 - d0));
    }
  }
  return kInterp;
}

/** The edit runs of trimmed A (n lines) into trimmed B (m lines): [{ kind, count }]
 *  with kind 0 keep, 1 delete, 2 insert, in order; null when no path of at
 *  most `cap` edits reaches both ends. A[n] and B[m] hold sentinel ids (-1 and
 *  -2) that match nothing, so the snake loop needs no bounds checks. Snapshot
 *  d is an Int32Array holding x+1 per diagonal (0 means no path), only as
 *  wide as its band, with diagonal k at index k - (kLo - 2); the cells
 *  outside the band stay 0 so a diagonal past the edge reads as "no path"
 *  without any bounds test. Only diagonals within cap - d of the final
 *  diagonal n - m are visited, and, when kInterp is given, only those within
 *  halfWidth of the anchors' interpolated diagonal at that depth: a shortest
 *  path of length at most cap can only be on those, so when cap is a true
 *  upper bound on the distance the search finds the reference's path, and
 *  only that. */
function editRuns(A, B, n, m, cap, kInterp, halfWidth) {
  const kStar = n - m;
  const Vs = [];
  const bases = [];
  // d = 0, diagonal 0 only: the snake from the start.
  let v = new Int32Array(5);
  let x = 0;
  while (A[x] === B[x]) x++;
  v[2] = x + 1;
  Vs.push(v);
  bases.push(-2);
  let D = 0;
  let kEnd = 0;
  let found = x === n && x === m;
  let prevLo = 0;
  for (let d = 1; !found && d <= cap; d++) {
    const Vp = Vs[d - 1];
    let kLo = -d;
    const bandLo = kStar - (cap - d);
    if (bandLo > kLo) kLo = bandLo;
    let kHi = d;
    const bandHi = kStar + (cap - d);
    if (bandHi < kHi) kHi = bandHi;
    if (kInterp !== null) {
      const c = kInterp[d];
      if (c - halfWidth > kLo) kLo = c - halfWidth;
      if (c + halfWidth < kHi) kHi = c + halfWidth;
    }
    if (((kLo + d) & 1) !== 0) kLo++;
    if (((kHi + d) & 1) !== 0) kHi--;
    if (kLo > kHi) break;
    // This snapshot covers diagonals kLo - 2 .. kHi + 2, so diagonal k
    // lives at index k - (kLo - 2); the outer cells stay 0.
    const base = kLo - 2;
    const basePrev = prevLo - 2;
    v = new Int32Array(kHi - kLo + 5);
    // Vp[i] is the stored value for the next diagonal already read; it
    // becomes this step's deletion candidate, so each cell is read once.
    let sp = Vp[kLo - 1 - basePrev];
    for (let k = kLo, i = kLo + 1 - basePrev, j = 2; k <= kHi; k += 2, i += 2, j += 2) {
      const sm = sp;
      sp = Vp[i];
      const vm = sm - 1;
      const vp = sp - 1;
      // A move is a candidate only when it stays inside its text: a deletion
      // needs an old line left (vm < n), an insertion a new line left
      // (vp - k - 1 < m, the index of the line it would insert). A missing
      // diagonal stores 0, so vm/vp is -1 and reads as a huge unsigned value,
      // failing both tests in one comparison each.
      const canRemove = (vm >>> 0) < n;
      const canAdd = (vp >>> 0) <= m + k;
      if (!canRemove && !canAdd) continue;
      // The candidate further into the old text, the deletion when both reach
      // one point: xd is the deletion's new x, xi the insertion's.
      const xd = canRemove ? vm + 1 : -1;
      const xi = canAdd ? vp : -1;
      x = xd >= xi ? xd : xi;
      let y = x - k;
      while (A[x] === B[y]) {
        x++;
        y++;
      }
      v[j] = x + 1;
      if (x === n && y === m) {
        D = d;
        kEnd = k;
        found = true;
        break;
      }
    }
    Vs.push(v);
    bases.push(base);
    prevLo = kLo;
  }
  if (!found) return null;

  // Walk the snapshots back from (D, kEnd), collecting runs in reverse order.
  // Each step recomputes its move from the snapshot below with the same rule
  // the forward pass used, so it follows the same path back.
  const rev = [];
  const push = (kind, count) => {
    const last = rev[rev.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else rev.push({ kind, count });
  };
  let k = kEnd;
  for (let d = D; d >= 1; d--) {
    const Vp = Vs[d - 1];
    const basePrev = bases[d - 1];
    const vcur = Vs[d][k - bases[d]] - 1;
    const vm = Vp[k - 1 - basePrev] - 1;
    const vp = Vp[k + 1 - basePrev] - 1;
    const canRemove = (vm >>> 0) < n;
    const canAdd = (vp >>> 0) <= m + k;
    const xd = canRemove ? vm + 1 : -1;
    const xi = canAdd ? vp : -1;
    const del = xd >= xi;
    const xStart = del ? xd : xi;
    const keep = vcur - xStart;
    if (keep > 0) push(KEEP, keep);
    push(del ? DEL : INS, 1);
    k = del ? k - 1 : k + 1;
  }
  const keep0 = Vs[0][2] - 1;
  if (keep0 > 0) push(KEEP, keep0);
  rev.reverse();
  return rev;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a
 *  line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of input.old into input.new, as fast as this module can. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const a = tokenize(input.old, map);
  const b = tokenize(input.new, map);
  const n = a.lines.length;
  const m = b.lines.length;
  // The common prefix, then the common suffix of what is left, on ids.
  let prefix = 0;
  while (prefix < n && prefix < m && a.ids[prefix] === b.ids[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a.ids[n - 1 - suffix] === b.ids[m - 1 - suffix]) suffix++;
  const n2 = n - prefix - suffix;
  const m2 = m - prefix - suffix;
  const A = new Int32Array(n2 + 1);
  const B = new Int32Array(m2 + 1);
  if (n2 > 0) A.set(a.ids.subarray(prefix, prefix + n2));
  if (m2 > 0) B.set(b.ids.subarray(prefix, prefix + m2));
  A[n2] = -1;
  B[m2] = -2;
  // The anchors and their bound, then the tight band around their diagonal,
  // falling back to the wide band and then to the full search.
  const dp = new Int32Array(m2 + 1);
  const ad = anchorData(A.subarray(0, n2), B.subarray(0, m2), n2, m2, map.size, dp);
  const cap = ad.bound;
  const kStar = n2 - m2;
  const halfWidth = Math.max(BAND_HALF_WIDTH, ad.maxGap + 50);
  const kInterp = anchorDiagonal(ad, cap, kStar);
  let midRuns = editRuns(A, B, n2, m2, cap, kInterp, halfWidth);
  if (midRuns === null) midRuns = editRuns(A, B, n2, m2, cap, null, 0);
  if (midRuns === null) midRuns = editRuns(A, B, n2, m2, n2 + m2, null, 0);

  // The runs, with the kept prefix and suffix folded in.
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  pushRun(KEEP, prefix);
  for (const r of midRuns) pushRun(r.kind, r.count);
  pushRun(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DEL) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a.lines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a.lines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b.lines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a.lines[at]));
  }
  return out.join('');
}
