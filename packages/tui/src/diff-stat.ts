/**
 * A tiny unified-diff stat parser for the LIVING RAIL. When a `patch_generated`
 * event carries its diff, the reducer folds it into a compact `+A −B · N file(s)`
 * annotation on the patch node — the "diffstat acumulado" DX detail, visible at a
 * glance without expanding the full diff (which lives in the run artifact).
 */

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * Counts added/removed lines and touched files in a unified diff. Header lines
 * (`+++`, `---`, `diff --git`, `@@`) are NOT counted as additions/deletions.
 * Files are counted from `diff --git` headers, falling back to `+++ ` headers
 * (a bare hunk with no file header counts as one file when it has any change).
 */
export function parseDiffStat(diff: string): DiffStat {
  if (diff.length === 0) {
    return { additions: 0, deletions: 0, files: 0 };
  }
  let additions = 0;
  let deletions = 0;
  let gitHeaders = 0;
  let plusHeaders = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      gitHeaders += 1;
    } else if (line.startsWith('+++')) {
      plusHeaders += 1;
    } else if (line.startsWith('---')) {
      // file header, ignore
    } else if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  const files =
    gitHeaders > 0 ? gitHeaders : plusHeaders > 0 ? plusHeaders : additions + deletions > 0 ? 1 : 0;
  return { additions, deletions, files };
}

/** Formats a {@link DiffStat} as `+24 −6 · 2 files` (or `1 file`); '' when empty. */
export function formatDiffStat(stat: DiffStat): string {
  if (stat.files === 0 && stat.additions === 0 && stat.deletions === 0) {
    return '';
  }
  const fileLabel = stat.files === 1 ? '1 file' : `${stat.files} files`;
  return `+${stat.additions} −${stat.deletions} · ${fileLabel}`;
}
