/** Line-oriented unified diff. Small, dependency free, good enough for configs. */

export interface DiffHunk {
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

export interface DiffOptions {
  context?: number;
  /** max lines before the diff is elided */
  maxLines?: number;
}

export function unifiedDiff(before: string, after: string, opts: DiffOptions = {}): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const changes = diffLines(a, b);
  if (changes.length === 0) return '';

  const context = opts.context ?? 3;
  const out: string[] = [];
  let i = 0;
  while (i < changes.length) {
    // find next change
    while (i < changes.length && changes[i]?.kind === 'ctx') i++;
    if (i >= changes.length) break;

    const start = Math.max(0, i - context);
    let end = i;
    while (end < changes.length) {
      if (changes[end]?.kind !== 'ctx') {
        end++;
        continue;
      }
      // look ahead: include the run of context only if a change follows soon
      let j = end;
      while (j < changes.length && changes[j]?.kind === 'ctx') j++;
      if (j < changes.length && j - end <= context * 2) {
        end = j;
        continue;
      }
      end += Math.min(context, j - end);
      break;
    }
    out.push(...changes.slice(start, end).map(render));
    i = end;
  }

  const maxLines = opts.maxLines ?? 400;
  if (out.length > maxLines) {
    return truncateKeepingChanges(out, maxLines);
  }
  return out.join('\n');
}

/**
 * Shrink an oversized diff while keeping the *meaningful* lines.
 *
 * A whole-file rewrite renders as every removal followed by every addition, so a
 * naive `slice(0, maxLines)` shows only deletions and hides every added line —
 * the user would approve changes they never saw. Removals and additions are kept
 * in roughly equal measure here, and context lines are dropped first.
 */
function truncateKeepingChanges(lines: string[], maxLines: number): string {
  const isChange = (line: string) => line.startsWith('+') || line.startsWith('-');
  const changes = lines.filter(isChange);
  const context = lines.filter((l) => !isChange(l));

  if (changes.length >= maxLines) {
    // still too many: take an even split across the two kinds of change
    const removed = changes.filter((l) => l.startsWith('-'));
    const added = changes.filter((l) => l.startsWith('+'));
    const budget = Math.max(1, Math.floor((maxLines - 1) / 2));

    const take = (list: string[], n: number) => {
      if (list.length <= n) return list;
      const head = Math.ceil(n / 2);
      const tail = n - head;
      return [
        ...list.slice(0, head),
        `… (${list.length - n} lines omitted)`,
        ...(tail > 0 ? list.slice(list.length - tail) : []),
      ];
    };

    const body = take(removed, budget);
    const rest = take(added, Math.max(1, maxLines - 1 - body.length));
    return [...body, ...rest, `… (${changes.length} changed lines)`].join('\n');
  }

  // enough room for every change: pad with context up to the budget
  const room = maxLines - changes.length;
  const head = context.slice(0, Math.ceil(room / 2));
  const tail = context.slice(context.length - Math.floor(room / 2));
  const omitted = context.length - head.length - tail.length;
  const merged = orderLines(lines, head, tail, changes, omitted);
  return merged.join('\n');
}

/**
 * Reassemble the trimmed diff in source order: the chosen context lines and all
 * change lines, with an omission marker where context was dropped.
 */
function orderLines(
  original: string[],
  head: string[],
  tail: string[],
  changes: string[],
  omitted: number,
): string[] {
  const keep = new Set([...head, ...tail, ...changes]);
  const out: string[] = [];
  let markerPlaced = false;
  for (const line of original) {
    if (keep.has(line)) {
      out.push(line);
      continue;
    }
    if (!markerPlaced) {
      out.push(`… (${omitted} context lines omitted)`);
      markerPlaced = true;
    }
  }
  return out;
}

function render(line: DiffLine): string {
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  return sign + line.text;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** Longest-common-subsequence line diff, with a simple size guard. */
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // too large: fall back to a coarse replace
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  const lcs = new Uint32Array((n + 1) * (m + 1));
  const idx = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[idx(i, j)] =
        a[i] === b[j]
          ? (lcs[idx(i + 1, j + 1)] ?? 0) + 1
          : Math.max(lcs[idx(i + 1, j)] ?? 0, lcs[idx(i, j + 1)] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] as string });
      i++;
      j++;
    } else if ((lcs[idx(i + 1, j)] ?? 0) >= (lcs[idx(i, j + 1)] ?? 0)) {
      out.push({ kind: 'del', text: a[i] as string });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] as string });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] as string });
  while (j < m) out.push({ kind: 'add', text: b[j++] as string });
  return out;
}
