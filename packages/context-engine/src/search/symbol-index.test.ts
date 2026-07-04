import { describe, expect, it } from 'vitest';
import { buildSymbolIndex, extractSymbols, searchSymbols } from './symbol-index';

describe('extractSymbols (G4 — language-aware definition extraction)', () => {
  it('extracts JS/TS functions, classes, types, interfaces and top-level consts', () => {
    const text = [
      'export function computeScope(a) {', // function
      '  return a;',
      '}',
      'class Widget {', // class
      '  render() {}', // NOT a top-level def (method) — must be ignored
      '}',
      'export interface MissionState { id: string }', // interface
      'export type Foo = string;', // type
      'export const runSwarmFlow = () => {};', // const
      '// function notReal() {}', // a comment — must be ignored
      'const x = usesComputeScope();', // an incidental mention — not a def of computeScope
    ].join('\n');
    const defs = extractSymbols('src/scope.ts', text);
    const byName = new Map(defs.map((d) => [d.name, d]));
    expect([...byName.keys()].sort()).toEqual([
      'Foo',
      'MissionState',
      'Widget',
      'computeScope',
      'runSwarmFlow',
      'x',
    ]);
    expect(byName.get('computeScope')?.kind).toBe('function');
    expect(byName.get('computeScope')?.line).toBe(1);
    expect(byName.get('MissionState')?.kind).toBe('interface');
    // `render` (a method) and `notReal` (in a comment) are NOT definitions.
    expect(byName.has('render')).toBe(false);
    expect(byName.has('notReal')).toBe(false);
  });

  it('extracts Python defs/classes and ignores unknown extensions', () => {
    const py = 'class Thing:\n    def do_it(self):\n        pass\n';
    const defs = extractSymbols('a/b.py', py)
      .map((d) => d.name)
      .sort();
    expect(defs).toEqual(['Thing', 'do_it']);
    expect(extractSymbols('notes.txt', 'function foo() {}')).toEqual([]);
  });
});

describe('searchSymbols (G4 — rank files by the symbols they DEFINE)', () => {
  const index = buildSymbolIndex([
    { path: 'src/scope.ts', text: 'export function computeScope() {}\nconst other = 1;' },
    { path: 'src/uses.ts', text: 'import { computeScope } from "./scope";\ncomputeScope();' }, // uses, not defines
    { path: 'src/mission.ts', text: 'export interface MissionState { id: string }' },
  ]);

  it('finds the DEFINING file for a symbol, not the file that merely uses it', () => {
    const hits = searchSymbols(index, ['computescope']); // case-insensitive
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('src/scope.ts');
    expect(hits[0]?.symbols).toContain('computeScope');
  });

  it('ranks a file higher when it defines more of the query symbols', () => {
    const idx = buildSymbolIndex([
      { path: 'a.ts', text: 'export function alpha() {}\nexport function beta() {}' },
      { path: 'b.ts', text: 'export function alpha() {}' },
    ]);
    const hits = searchSymbols(idx, ['alpha', 'beta']);
    expect(hits[0]?.path).toBe('a.ts'); // defines both → ranks first
    expect(hits.map((h) => h.path)).toContain('b.ts');
  });

  it('ignores query terms shorter than 3 chars and unknown symbols', () => {
    expect(searchSymbols(index, ['id', 'xx', 'nope'])).toEqual([]);
  });
});
