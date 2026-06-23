/**
 * Dependency-graph → execution WAVES (AO3b). Pure, deterministic Kahn-style
 * topological levelization shared by the swarm allocator and the staged executor
 * (AO3c). Items with no unmet dependency form wave 0 and run in parallel; their
 * dependents form wave 1, and so on. This is what turns the long-discarded
 * `dependsOn` field into a real A→{B,C}→D schedule instead of a flat fan-out.
 *
 * Rules (all deterministic, no I/O):
 *  - a dependency on an id NOT in the set is ignored (dangling — never blocks);
 *  - a self-dependency is ignored;
 *  - input order is preserved WITHIN a wave (stable);
 *  - a true cycle returns `null` (the caller falls back to a single sequential
 *    lane — a graph you cannot order is not safe to fan out).
 */

/** Minimal shape the levelizer needs: a stable id + optional upstream ids. */
export interface DependencyNode {
  id: string;
  dependsOn?: ReadonlyArray<string>;
}

/**
 * Levelizes `items` into dependency WAVES (each wave's items are mutually
 * independent and run in parallel; wave N+1 depends only on waves ≤ N). Returns
 * `null` if the graph contains a cycle. Preserves the original objects (generic
 * over `T`) so callers keep their lane payloads.
 */
export function topologicalWaves<T extends DependencyNode>(items: ReadonlyArray<T>): T[][] | null {
  const ids = new Set(items.map((i) => i.id));
  // Real (in-set, non-self) dependencies per id.
  const deps = new Map<string, Set<string>>();
  for (const it of items) {
    deps.set(it.id, new Set((it.dependsOn ?? []).filter((d) => d !== it.id && ids.has(d))));
  }

  const placed = new Set<string>();
  const waves: T[][] = [];
  let remaining: T[] = items.slice();

  while (remaining.length > 0) {
    // A node is ready when every real dependency is already placed.
    const ready = remaining.filter((it) => {
      for (const dep of deps.get(it.id) ?? new Set<string>()) {
        if (!placed.has(dep)) return false;
      }
      return true;
    });
    if (ready.length === 0) {
      return null; // nothing can advance ⇒ a cycle
    }
    waves.push(ready);
    for (const it of ready) placed.add(it.id);
    remaining = remaining.filter((it) => !placed.has(it.id));
  }

  return waves;
}
