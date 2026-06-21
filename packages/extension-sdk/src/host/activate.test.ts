import { describe, expect, it } from 'vitest';
import { ExtensionRegistry, type LoadedExtension } from '@excalibur/extension-runtime';
import { defineExtension } from '../define-extension';
import type { AgentTool } from '../interfaces/tools';
import { activateExtensions } from './activate';

/**
 * Activation runs each loaded extension's `register(ctx)` (which the runtime
 * loader deliberately does NOT) and harvests the agent tools they contribute,
 * isolated from the loader's manifest-name placeholders. A faulty extension is
 * reported, never fatal (P0.1).
 */

function tool(name: string, output = 'ok'): AgentTool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: () => Promise.resolve({ success: true, output }),
  };
}

function loaded(id: string, instance: unknown): LoadedExtension {
  return {
    manifest: { id, name: id, version: '1.0.0', kind: 'programmatic', entrypoint: 'dist/index.js' },
    source: 'local',
    dir: `/tmp/${id}`,
    status: 'loaded',
    instance,
  };
}

describe('activateExtensions', () => {
  it('runs register() and harvests the contributed tools', async () => {
    const registry = new ExtensionRegistry();
    registry.addExtension(
      loaded(
        'demo',
        defineExtension({
          id: 'demo',
          name: 'Demo',
          version: '1.0.0',
          register(ctx) {
            ctx.tools.registerTool(tool('hello', 'hi'));
          },
        }),
      ),
    );

    const { tools, warnings } = await activateExtensions(registry);
    expect(tools.map((t) => t.name)).toEqual(['hello']);
    expect(typeof tools[0]?.execute).toBe('function');
    expect(warnings).toHaveLength(0);
  });

  it('isolates a failing extension and still activates the others', async () => {
    const registry = new ExtensionRegistry();
    registry.addExtension(
      loaded(
        'bad',
        defineExtension({
          id: 'bad',
          name: 'Bad',
          version: '1.0.0',
          register() {
            throw new Error('activation blew up');
          },
        }),
      ),
    );
    registry.addExtension(
      loaded(
        'good',
        defineExtension({
          id: 'good',
          name: 'Good',
          version: '1.0.0',
          register(ctx) {
            ctx.tools.registerTool(tool('works'));
          },
        }),
      ),
    );

    const { tools, warnings } = await activateExtensions(registry);
    expect(tools.map((t) => t.name)).toEqual(['works']);
    expect(warnings.some((w) => w.includes("'bad' failed to activate"))).toBe(true);
  });

  it('drops a duplicate tool name across extensions (first wins)', async () => {
    const registry = new ExtensionRegistry();
    registry.addExtension(
      loaded(
        'a',
        defineExtension({
          id: 'a',
          name: 'A',
          version: '1.0.0',
          register(ctx) {
            ctx.tools.registerTool(tool('dup', 'from-a'));
          },
        }),
      ),
    );
    registry.addExtension(
      loaded(
        'b',
        defineExtension({
          id: 'b',
          name: 'B',
          version: '1.0.0',
          register(ctx) {
            ctx.tools.registerTool(tool('dup', 'from-b'));
          },
        }),
      ),
    );

    const { tools, warnings } = await activateExtensions(registry);
    expect(tools).toHaveLength(1);
    const result = await tools[0]?.execute(
      {},
      {
        workdir: '/tmp',
        config: {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    );
    expect(result?.output).toBe('from-a');
    expect(warnings.some((w) => w.includes("Tool 'dup'"))).toBe(true);
  });

  it('skips extensions that failed to load or have no instance', async () => {
    const registry = new ExtensionRegistry();
    registry.addExtension({
      manifest: { id: 'broken', name: 'broken', version: '1.0.0', kind: 'programmatic' },
      source: 'local',
      dir: '/tmp/broken',
      status: 'error',
      error: 'entrypoint not found',
    });
    registry.addExtension({
      manifest: { id: 'declarative-only', name: 'd', version: '1.0.0', kind: 'declarative' },
      source: 'project',
      dir: '/tmp/d',
      status: 'loaded',
    });

    const { tools, warnings } = await activateExtensions(registry);
    expect(tools).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
