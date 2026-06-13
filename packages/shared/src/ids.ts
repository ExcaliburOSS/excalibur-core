import { randomUUID } from 'node:crypto';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Generates a local run id in the form `run_YYYYMMDD_HHMMSS` using LOCAL time
 * (run directories should sort naturally next to the developer's clock).
 */
export function generateRunId(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `run_${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

/** Generates a collision-resistant id in the form `<prefix>_<uuid>`. */
export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
