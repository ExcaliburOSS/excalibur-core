import {
  DiscoveryManager,
  InteractionStore,
  MESH_LENSES,
  PatchStore,
  RunManager,
  SessionStore,
  SprintStore,
  collectInsights,
  computeBurndown,
  getLocalDiff,
  listPlans,
  loadCustomAgents,
  planProgress,
  planVerificationMesh,
  readPlan,
  type BurndownItem,
} from '@excalibur/core';
import type { ExcaliburEvent } from '@excalibur/shared';
import {
  LocalWorkItemProvider,
  WORK_ITEM_LANE_LABELS,
  laneOf,
  type NormalizedWorkItem,
} from '@excalibur/work-items';
import type { ManagementToolset } from '@excalibur/agent-runtime';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext } from './context';
import { scanSkills } from './isd';
import { runVerificationMesh } from './verification';

/**
 * The host implementation of the agent-callable MANAGEMENT tools (the proactive
 * foundation): each reads the SAME local stores the `excalibur <command>`s use
 * and returns concise, agent-friendly TEXT so the model can weave real project
 * state into its conversation. agent-runtime declares the shape; this layer (the
 * CLI, which owns the stores) provides the behaviour and is injected per run.
 *
 * Read-only by construction — every method only reads stores. The work-item
 * store is namespaced `integrationId: 'local'`, matching the `--local` provider
 * the `work-items` command uses.
 */
export function buildManagementToolset(deps: CliDeps, repoRoot: string): ManagementToolset {
  return {
    async projectStatus({ discovery }): Promise<string> {
      const runs = new RunManager(repoRoot).listRuns();
      const patches = new PatchStore(repoRoot).list();
      const interactions = new InteractionStore(repoRoot).list();
      const lines: string[] = [
        `Runs: ${runs.length} · Patches: ${patches.length} · Interactions: ${interactions.length}`,
      ];
      const latest = runs[runs.length - 1];
      if (latest !== undefined) {
        lines.push(
          `Latest run: "${latest.record.title}" — ${latest.record.status} ` +
            `(${latest.record.workflow}, L${latest.record.autonomyLevel})`,
        );
      }
      try {
        const board = new LocalWorkItemProvider(repoRoot).board();
        const summary = board
          .filter((lane) => lane.items.length > 0)
          .map((lane) => `${WORK_ITEM_LANE_LABELS[lane.lane]} ${lane.items.length}`)
          .join(' · ');
        lines.push(`Work items: ${summary.length > 0 ? summary : 'none yet'}`);
      } catch {
        /* the local board is best-effort — skip if the store can't be read */
      }
      if (discovery === true) {
        const sessions = new DiscoveryManager(repoRoot).listSessions();
        const last = sessions[sessions.length - 1];
        if (last !== undefined) {
          lines.push(`Discovery sessions: ${sessions.length} (latest: "${last.record.title}")`);
        }
      }
      return lines.join('\n');
    },

    async workItems({ status, query, labels, limit, key }): Promise<string> {
      const provider = new LocalWorkItemProvider(repoRoot);
      if (key !== undefined && key.length > 0) {
        try {
          const item = await provider.getWorkItem({ integrationId: 'local', externalIdOrKey: key });
          return formatWorkItemDetail(item);
        } catch {
          return `No work item found with key "${key}".`;
        }
      }
      let items = await provider.listWorkItems({
        integrationId: 'local',
        ...(query !== undefined ? { query } : {}),
        ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
        limit: limit ?? 20,
      });
      if (status !== undefined && status.length > 0) {
        const want = status.toLowerCase();
        items = items.filter(
          (i) => laneOf(i.status) === want || (i.status ?? '').toLowerCase() === want,
        );
      }
      if (items.length === 0) {
        return 'No work items match.';
      }
      return items
        .map((i) => {
          const who = assigneeName(i);
          return (
            `${i.key} [${WORK_ITEM_LANE_LABELS[laneOf(i.status)]}] ${i.title}` +
            `${i.estimate != null ? ` (${i.estimate}pt)` : ''}` +
            `${who !== '' ? ` · @${who}` : ''}`
          );
        })
        .join('\n');
    },

    async sprintStatus({ sprintId }): Promise<string> {
      const store = new SprintStore(repoRoot);
      const sprint = sprintId !== undefined ? store.getSprint(sprintId) : store.activeSprint();
      if (sprint === null) {
        return sprintId !== undefined ? `No sprint "${sprintId}".` : 'No active sprint.';
      }
      const items = (
        await new LocalWorkItemProvider(repoRoot).listWorkItems({ integrationId: 'local' })
      ).filter((w) => w.cycleOrSprint === sprint.id);
      const burndown = computeBurndown(sprint.startDate, sprint.endDate, items.map(toBurndownItem));
      return [
        `Sprint "${sprint.name}" (${sprint.status}) — ${sprint.startDate} → ${sprint.endDate}`,
        sprint.goal != null && sprint.goal.length > 0 ? `Goal: ${sprint.goal}` : '',
        `Points: ${burndown.donePoints}/${burndown.totalPoints} done · ${burndown.itemCount} items`,
        burndown.days.length > 0
          ? `Remaining trend: ${burndown.days.map((d) => d.remaining).join(' → ')}`
          : '',
      ]
        .filter((l) => l.length > 0)
        .join('\n');
    },

    async plans({ id }): Promise<string> {
      if (id !== undefined && id.length > 0) {
        const stored = readPlan(repoRoot, id);
        if (stored === null) {
          return `No plan "${id}".`;
        }
        const prog = planProgress(stored.plan);
        const steps = stored.plan.phases
          .flatMap((ph) => ph.steps)
          .map((s, i) => `  ${i + 1}. [${s.status}] ${s.title}`)
          .join('\n');
        return (
          `Plan ${stored.id}: "${stored.task}" (${stored.status})\n` +
          `Progress: ${prog.done}/${prog.total} done` +
          `${prog.blocked > 0 ? `, ${prog.blocked} blocked` : ''}\n${steps}`
        );
      }
      const plans = listPlans(repoRoot);
      if (plans.length === 0) {
        return 'No saved plans.';
      }
      return plans
        .map((p) => {
          const prog = planProgress(p.plan);
          return `${p.id} [${p.status}] "${p.task}" — ${prog.done}/${prog.total} steps`;
        })
        .join('\n');
    },

    async insights({ sinceDays }): Promise<string> {
      const opts =
        sinceDays !== undefined && sinceDays > 0
          ? { sinceIso: new Date(Date.now() - sinceDays * 86_400_000).toISOString() }
          : {};
      const r = collectInsights(repoRoot, opts);
      if (r.totalRuns === 0) {
        return 'No runs recorded yet — nothing to report.';
      }
      const byModel = r.byModel
        .slice(0, 4)
        .map((m) => `${m.key} ${m.runs}r/$${(m.costCents / 100).toFixed(2)}`)
        .join(', ');
      return [
        `Runs: ${r.totalRuns} · completion ${(r.completionRate * 100).toFixed(0)}% · ` +
          `$${(r.totalCostCents / 100).toFixed(2)} · ${r.totalInputTokens + r.totalOutputTokens} tokens`,
        `Files changed: ${r.totalFilesChanged} · approvals: ${r.totalApprovals} · ` +
          `verifications blocked: ${r.totalVerificationsBlocked}`,
        byModel.length > 0 ? `By model: ${byModel}` : '',
      ]
        .filter((l) => l.length > 0)
        .join('\n');
    },

    async runLogs({ runId, limit }): Promise<string> {
      const mgr = new RunManager(repoRoot);
      const run = runId !== undefined ? mgr.getRun(runId) : mgr.latestRun();
      if (run === null || run === undefined) {
        return runId !== undefined ? `No run "${runId}".` : 'No runs recorded yet.';
      }
      const events = mgr.readEvents(run.id);
      const tail = events.slice(-(limit ?? 40));
      const head = `Run ${run.id}: "${run.record.title}" — ${run.record.status} (${run.record.workflow})`;
      const body = tail.map((e) => `  ${describeRunEvent(e)}`).join('\n');
      return `${head}\n${body}`;
    },

    async listAgents(): Promise<string> {
      const agents = loadCustomAgents({
        repoRoot,
        homeDir: deps.homeDir(),
        includeGlobal: deps.includeUserGlobal,
      });
      if (agents.size === 0) {
        return 'No custom agents defined (.excalibur/agents/*.md).';
      }
      return [...agents.values()]
        .map(
          (a) =>
            `${a.name} — ${a.description}` +
            `${a.role !== undefined ? ` [${a.role}]` : ''}` +
            `${a.model !== undefined ? ` (${a.model})` : ''}`,
        )
        .join('\n');
    },

    async listSkills(): Promise<string> {
      const skills = await scanSkills(deps, repoRoot);
      if (skills.length === 0) {
        return 'No skills found.';
      }
      return skills
        .map(
          (s) =>
            `${s.name} [${s.trustLevel}] ${s.enabled ? 'enabled' : 'disabled'}` +
            `${s.description != null && s.description.length > 0 ? ` — ${s.description}` : ''}`,
        )
        .join('\n');
    },

    async sessions({ id }): Promise<string> {
      const store = new SessionStore(repoRoot);
      if (id !== undefined && id.length > 0) {
        let session;
        try {
          session = store.getSession(id);
        } catch {
          return `No session "${id}".`;
        }
        const turns = store.readTranscript(id);
        const m = session.metadata;
        return (
          `Session ${m.id}: "${m.title}" (${m.status}) — ${m.turnCount} turns, model ${m.lastModel}\n` +
          turns
            .slice(-8)
            .map((t) => `  ${t.role}/${t.kind}: ${t.text.slice(0, 80)}`)
            .join('\n')
        );
      }
      const all = store.listSessions();
      if (all.length === 0) {
        return 'No sessions recorded yet.';
      }
      return all
        .slice(-12)
        .reverse()
        .map(
          (s) =>
            `${s.metadata.id} "${s.metadata.title}" — ${s.metadata.turnCount} turns ` +
            `(${s.metadata.status}, ${s.metadata.lastModel})`,
        )
        .join('\n');
    },

    async verify(): Promise<string> {
      const diff = getLocalDiff(repoRoot);
      if (diff.trim().length === 0) {
        return 'Nothing to verify — the working tree has no changes.';
      }
      const gw = loadGatewayContext(repoRoot);
      if (gw.providerName === 'mock') {
        return 'verify needs a real configured model (the mock provider is active).';
      }
      const { config } = loadConfigContext(repoRoot);
      const plan = planVerificationMesh({
        taskType: 'feature',
        sensitive: false,
        affectedUnits: countDiffFiles(diff),
        autonomyLevel: 4,
        hasTests: typeof config.commands?.test === 'string',
        mode: 'always', // an explicit verify request always runs ≥1 lens
      });
      const result = await runVerificationMesh({
        diff,
        lenses: plan.lenses,
        gateway: gw.gateway,
        provider: gw.providerName,
      });
      const head = result.blocked
        ? `Verification FOUND issues (${plan.lenses.map((l) => MESH_LENSES[l].label).join(', ')}):`
        : `Verification passed (${plan.lenses.map((l) => MESH_LENSES[l].label).join(', ')}).`;
      const issues = result.issues
        .map(
          (i) =>
            `  [${i.severity.toUpperCase()}] ${i.file !== undefined ? `${i.file} — ` : ''}${i.problem}` +
            `${i.fix !== undefined ? ` → ${i.fix}` : ''}`,
        )
        .join('\n');
      return issues.length > 0 ? `${head}\n${issues}` : `${head}\n${result.summary}`;
    },

    async review(): Promise<string> {
      const diff = getLocalDiff(repoRoot);
      if (diff.trim().length === 0) {
        return 'Nothing to review — the working tree has no changes.';
      }
      const gw = loadGatewayContext(repoRoot);
      if (gw.providerName === 'mock') {
        return 'review needs a real configured model (the mock provider is active).';
      }
      const out = await gw.gateway.chat({
        messages: [
          {
            role: 'system',
            content:
              'You are a meticulous senior code reviewer. Review the working-tree diff for ' +
              'bugs, security issues, edge cases, missing tests and style. Be concise and ' +
              'specific — cite files and lines. If it looks good, say so briefly.',
          },
          { role: 'user', content: `Review these changes:\n\n${diff.slice(0, 24_000)}` },
        ],
      });
      return out.content.trim().length > 0 ? out.content.trim() : 'No review feedback.';
    },
  };
}

/** A one-line description of a run event for the `run_logs` tool. */
function describeRunEvent(e: ExcaliburEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const detail =
    typeof p['name'] === 'string'
      ? p['name']
      : typeof p['title'] === 'string'
        ? p['title']
        : typeof p['command'] === 'string'
          ? p['command']
          : '';
  return `${e.type}${detail !== '' ? `: ${String(detail).slice(0, 80)}` : ''}`;
}

/** Counts the files a unified diff touches (`diff --git` headers). */
function countDiffFiles(diff: string): number {
  const m = diff.match(/^diff --git /gm);
  return m !== null ? m.length : 1;
}

/** Projects a work-item into a burndown item (mirrors the `sprints` command). */
function toBurndownItem(item: NormalizedWorkItem): BurndownItem {
  const done = laneOf(item.status) === 'done';
  return {
    points: item.estimate ?? 1,
    doneDate: done ? (item.updatedAt ?? '').slice(0, 10) || null : null,
  };
}

/** A compact, agent-readable detail block for a single work item. */
function formatWorkItemDetail(item: NormalizedWorkItem): string {
  const who = assigneeName(item);
  const lines = [
    `${item.key} [${WORK_ITEM_LANE_LABELS[laneOf(item.status)]}] ${item.title}`,
    item.description != null && item.description.length > 0
      ? `Description: ${item.description}`
      : '',
    item.estimate != null ? `Estimate: ${item.estimate}pt` : '',
    who !== '' ? `Assignee: @${who}` : '',
    item.labels.length > 0 ? `Labels: ${item.labels.join(', ')}` : '',
    item.cycleOrSprint != null ? `Sprint: ${item.cycleOrSprint}` : '',
    item.blockedBy != null && item.blockedBy.length > 0
      ? `Blocked by: ${item.blockedBy.join(', ')}`
      : '',
  ];
  return lines.filter((l) => l.length > 0).join('\n');
}

/** Best display name for a work item's assignee (every field is nullable). */
function assigneeName(item: NormalizedWorkItem): string {
  const a = item.assignee;
  if (a == null) {
    return '';
  }
  return a.name ?? a.username ?? a.externalId ?? '';
}
