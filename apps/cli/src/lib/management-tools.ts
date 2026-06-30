import {
  DiscoveryManager,
  InteractionStore,
  PatchStore,
  MemoryStore,
  RunManager,
  SessionStore,
  SprintStore,
  collectInsights,
  computeBurndown,
  getLocalDiff,
  listPlans,
  loadCustomAgents,
  planProgress,
  readPlan,
  scopeMapToMarkdown,
  type BurndownItem,
} from '@excalibur/core';
import { redactSecrets } from '@excalibur/model-gateway';
import type { ExcaliburEvent } from '@excalibur/shared';
import { computeScope } from './scope';
import { loadGatewayContext } from './context';
import {
  LocalWorkItemProvider,
  WORK_ITEM_LANE_LABELS,
  laneOf,
  type NormalizedWorkItem,
} from '@excalibur/work-items';
import type { ManagementToolset } from '@excalibur/agent-runtime';
import type { CliDeps } from '../deps';
import { scanSkills } from './isd';

/** A bounded, redacted slice of the working-tree diff for the self-check tools. */
const DIFF_BUDGET = 24_000;

/**
 * Max parallel read-only explorer angles the agent-callable `investigate` tool fans out
 * (RUN-FIX-22 follow-up). Bounded TIGHTER than the explicit `/scope` command: the explorer
 * model-calls are nested and don't count against the run's hard budget cap, so keep the
 * proactive mid-turn investigation cheap (the engine clamps to its own hard cap regardless).
 */
const INVESTIGATE_MAX_ANGLES = 4;

/**
 * The host implementation of the agent-callable MANAGEMENT tools (the proactive
 * foundation): each reads the SAME local stores the `excalibur <command>`s use
 * and returns concise, agent-friendly TEXT so the model can weave real project
 * state into its conversation. agent-runtime declares the shape; this layer (the
 * CLI, which owns the stores) provides the behaviour and is injected per run.
 *
 * Read-only by construction — every method only reads stores (or, for
 * verify/review, returns the diff for the AGENT to self-check in its OWN budgeted,
 * counted, redacted loop — never a nested/uncounted model call). The work-item
 * store is namespaced `integrationId: 'local'`, matching the `--local` provider
 * the `work-items` command uses.
 *
 * `workdir` defaults to `repoRoot` but is passed explicitly for a fork-from-cache
 * turn (the agent edits the worktree, not the repo root), so verify/review read
 * the diff the agent is ACTUALLY producing while the store reads stay on repoRoot.
 */
export function buildManagementToolset(
  deps: CliDeps,
  repoRoot: string,
  opts: { workdir?: string } = {},
): ManagementToolset {
  const workdir = opts.workdir ?? repoRoot;
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
      const wantLane = status !== undefined && status.length > 0;
      let items = await provider.listWorkItems({
        integrationId: 'local',
        ...(query !== undefined ? { query } : {}),
        ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
        // When filtering by lane (client-side, below), fetch a generous bound first
        // — capping BEFORE the filter would silently drop matching items.
        limit: wantLane ? 500 : (limit ?? 20),
      });
      if (wantLane) {
        const want = status.toLowerCase();
        items = items
          .filter((i) => laneOf(i.status) === want || (i.status ?? '').toLowerCase() === want)
          .slice(0, limit ?? 20);
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
      // Clamp the window (≤100y) so a huge sinceDays can't produce an out-of-range Date.
      const days = sinceDays !== undefined && sinceDays > 0 ? Math.min(sinceDays, 36_500) : 0;
      const opts =
        days > 0 ? { sinceIso: new Date(Date.now() - days * 86_400_000).toISOString() } : {};
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

    // verify/review return the (redacted) working-tree diff + a framing checklist
    // for the agent to self-check IN ITS OWN loop. They deliberately make NO nested
    // model call: that would spend through a separate gateway invisible to the run's
    // hard budget cap + cost accounting, and could ship an unredacted diff to the
    // provider. The agent's own turn is budgeted, counted and redacted.
    verify(): Promise<string> {
      const diff = getLocalDiff(workdir);
      if (diff.trim().length === 0) {
        return Promise.resolve('Nothing to verify — the working tree has no changes.');
      }
      return Promise.resolve(
        'Verify YOUR current working-tree changes across these adversarial lenses, then report ' +
          'any issues you find (with file + fix):\n' +
          '- correctness (logic, edge cases, error handling)\n' +
          '- security (injection, secrets, unsafe input)\n' +
          '- regression (does it break existing behaviour)\n' +
          '- spec (does it actually do what was asked)\n' +
          '- reproducibility (does it build/typecheck/test)\n\n' +
          `Working-tree diff:\n${redactSecrets(diff).slice(0, DIFF_BUDGET)}`,
      );
    },

    review(): Promise<string> {
      const diff = getLocalDiff(workdir);
      if (diff.trim().length === 0) {
        return Promise.resolve('Nothing to review — the working tree has no changes.');
      }
      return Promise.resolve(
        'Review YOUR current working-tree changes like a meticulous senior reviewer — bugs, ' +
          'security, edge cases, missing tests, style. Be specific (cite files/lines); if it ' +
          'looks good, say so briefly.\n\n' +
          `Working-tree diff:\n${redactSecrets(diff).slice(0, DIFF_BUDGET)}`,
      );
    },

    async remember({ statement, subjectPaths }): Promise<string> {
      const text = (statement ?? '').trim();
      if (text.length === 0) {
        return 'Nothing to remember — provide a statement.';
      }
      // Infer subject paths from path-like mentions when the caller omits them, so a
      // future run touching those files is primed with this memory (mirrors /remember).
      const paths =
        subjectPaths !== undefined && subjectPaths.length > 0
          ? subjectPaths
          : [...new Set(text.match(/[\w.-]+(?:\/[\w.-]+)+/g) ?? [])];
      try {
        const node = new MemoryStore(repoRoot).capture({
          type: 'decision',
          statement: redactSecrets(text),
          subjectPaths: paths,
        });
        const where = paths.length > 0 ? ` (paths: ${paths.join(', ')})` : '';
        return node.evidenceCount > 1
          ? `Reinforced an existing project memory (now ${node.evidenceCount} corroborations)${where}.`
          : `Saved a project memory${where}. Future runs touching it will be primed with this.`;
      } catch (error) {
        return `Could not save the memory: ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    async investigate({ task }): Promise<string> {
      const focus = (task ?? '').trim();
      if (focus.length === 0) {
        return 'Nothing to investigate — provide a task or question.';
      }
      const gw = loadGatewayContext(repoRoot);
      // Parallel exploration needs a REAL model — the mock returns templated text.
      if (!gw.configured || gw.providerName === 'mock') {
        return 'Cannot investigate — no real model is configured for parallel exploration.';
      }
      try {
        // Fan out READ-ONLY explorers (each only RETRIEVES files + reasons — the safety
        // floor is structural: no write/patch/run). Bound the fan-out TIGHTER than the
        // explicit `/scope` command: these explorer model-calls are nested and so do not
        // count against the run's hard budget cap (like verify/review), so keep it cheap.
        const map = await computeScope(repoRoot, focus, gw, { angles: INVESTIGATE_MAX_ANGLES });
        if (map === null) {
          return 'Nothing concrete to report — the task could not be decomposed into areas to explore (it may be too small or outside this repo).';
        }
        return scopeMapToMarkdown(map);
      } catch (error) {
        return `Investigation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** A one-line, secret-redacted description of a run event for the `run_logs` tool. */
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
  // A command/title can carry a token or URL secret — redact before it reaches the model.
  return redactSecrets(`${e.type}${detail !== '' ? `: ${String(detail).slice(0, 80)}` : ''}`);
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
