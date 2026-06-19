# Discovery — Excalibur Core scope

Discovery is a lightweight, conversational, optional pre-work methodology: it clarifies ideas, tickets, customer feedback or technical initiatives **before** they become assisted or agentic engineering work, and it must be able to recommend _not_ building. It is never a mandatory PRD process, a heavy PM tool or a waterfall gate.

> Before Excalibur builds, Excalibur helps teams decide what should be built.

The full Enterprise module (DB sessions, web UI, Slack, work-item commands) lives in Excalibur Enterprise. Excalibur Core owns: the **deterministic scoring/recommendation contract** (`@excalibur/shared` → `discovery.ts`, frozen), the **methodology + workflow catalog entries and question packs** (`@excalibur/workflow-schema`), the **local CLI flow** (`@excalibur/core` + CLI, phase D-7) and the Discovery **commands in the common parser** (`@excalibur/work-items`).

## 1. Modes

`product_idea (idea), existing_work_item (work_item), customer_feedback, technical_initiative, incident, agent_readiness, mvp_scope` — internally selected; the user just runs "Discovery". 4–8 adaptive questions, practical output.

## 2. Question packs (`DISCOVERY_QUESTION_PACKS` in workflow-schema)

Keyed by `DiscoveryInputType`. Each question: `{ id: string; text: string }`. Scoring inspects well-known ids: `problem, user, current_workaround, urgency, mvp, out_of_scope, success, evidence, risks, readiness`.

**base** (used for `incident`, `mvp_scope`, `other`):

```text
problem: What problem are we trying to solve?
user: Who has this problem?
current_workaround: What do they do today?
urgency: Why does it matter now?
mvp: What is the smallest useful version?
out_of_scope: What is explicitly out of scope?
success: How will we know it worked?
evidence: What evidence do we have?
risks: What risks or unknowns remain?
readiness: Is this ready for implementation?
```

**idea** (product idea):

```text
user: Who specifically has this problem?
problem: What painful workflow are they experiencing?
current_workaround: What workaround do they use today?
frequency: How often does this happen?
urgency: What happens if they do nothing?
impact: What is the buying, retention or activation impact?
mvp: What is the smallest useful version?
kill_criteria: What would make this not worth building?
```

**work_item** (existing ticket):

```text
problem: Is the user/problem clear from this ticket?
acceptance: Are acceptance criteria present?
expected: Is the expected behavior clear?
repo: Is the target repository known?
dependencies: Are there dependencies or linked tickets?
out_of_scope: What is explicitly out of scope?
tests: What tests should pass?
readiness: Is this ready for implementation?
```

**customer_feedback**:

```text
verbatim: What did the customer actually say?
problem: Is this a request, a symptom or a real problem?
segment: What segment does this customer belong to?
evidence: How many customers have mentioned this?
current_workaround: What workaround do they use today?
impact: Is this blocking purchase, activation or retention?
validation: What cheap validation could we run?
```

**technical_initiative**:

```text
problem: What technical problem are we solving?
urgency: What happens if we do nothing?
driver: Is this reliability-, cost-, security- or productivity-driven?
systems: What systems are affected?
mvp: What is the smallest safe change?
success: What tests or metrics would prove success?
risks: Does this require migration, rollback or feature flags?
reviewer: Who should review this?
```

**agent_readiness**:

```text
problem: Is the goal clear enough for an agent?
acceptance: Are acceptance criteria present?
repo: Is the target repo known?
modules: Are affected modules known?
tests: Is there enough test coverage?
risks: Does it touch sensitive areas?
mode: Should AI only plan, propose a patch, or implement?
approval: Is human approval required before implementation?
```

## 3. Outputs and recommendation

Artifacts (markdown unless noted): `discovery-summary.md` (problem, user, workaround, evidence, urgency, scope, out of scope, open questions, recommendation), `refined-ticket.md` (title, problem, expected behavior, acceptance criteria, scope, out of scope, implementation notes, test expectations, links), `acceptance-criteria.md`, `mvp-scope.md` (in/out of scope, first shippable version, later iterations, overbuild risks), `readiness-assessment.md` (the diagnostic card), `recommendation.md` (value + reasons), `discovery.json` (= `DiscoveryRecord` from shared), plus `input.md` and `transcript.md`.

Readiness card format:

```text
Problem clarity: Low / Medium / High
User evidence: Low / Medium / High
Scope clarity: Low / Medium / High
Technical risk: Low / Medium / High
Agent readiness: Not ready / Plan only / Patch ready / Implementation ready
Recommended autonomy level: 0-4
Recommended workflow: <key>
Recommendation: <value>
Reason: <explanation lines>
```

Recommendation values and scoring/recommendation rules are implemented in the frozen `@excalibur/shared` `discovery.ts` (`scoreDiscoveryTranscript`, `recommendFromScores`) — use them, do not reimplement.

## 4. Methodology catalog entry (verbatim-normative)

`default-methodologies/discovery.yaml`:

```yaml
id: discovery
name: Discovery
category: pre_work
description: >
  A lightweight methodology to clarify ideas, tickets, feedback or technical initiatives before implementation.
recommendedAutonomyLevels: [0, 1]
useWhen:
  - The idea is ambiguous
  - The target user or problem is unclear
  - A ticket lacks acceptance criteria
  - Customer feedback needs synthesis
  - A technical initiative needs framing
  - The team is unsure whether an agent should implement it
  - The work may need validation before build
avoidWhen:
  - The task is a clear bugfix
  - The change is mechanical
  - The ticket is already implementation-ready
  - The work is urgent and well scoped
defaultWorkflow: discovery
phases:
  - intake
  - questions
  - synthesis
  - readiness
  - recommendation
outputs:
  - discovery-summary.md
  - refined-ticket.md
  - acceptance-criteria.md
  - mvp-scope.md
  - readiness-assessment.md
  - recommendation.md
modes:
  - product_idea
  - existing_work_item
  - customer_feedback
  - technical_initiative
  - incident
  - agent_readiness
  - mvp_scope
questions:
  - id: problem
    text: What problem are we trying to solve?
  - id: user
    text: Who has this problem?
  - id: current_workaround
    text: What do they do today?
  - id: urgency
    text: Why does it matter now?
  - id: mvp
    text: What is the smallest useful version?
  - id: out_of_scope
    text: What is explicitly out of scope?
  - id: success
    text: How will we know it worked?
  - id: evidence
    text: What evidence do we have?
  - id: readiness
    text: Is this ready for implementation by a human or an agent?
riskProfile: low
```

(NOTE: `defaultWorkflow`, `phases` and `riskProfile` added relative to the raw spec so the file validates against the methodology schema; `category/outputs/modes/questions` are new optional schema fields.)

## 5. Workflow catalog entry (verbatim-normative)

`default-workflows/discovery.yaml`:

```yaml
id: discovery
name: Discovery
mode: discovery
supportedAutonomyLevels: [0, 1]
description: >
  Lightweight conversational pre-work flow to clarify ideas, tickets, feedback or technical initiatives before implementation.
phases:
  - id: intake
    name: Intake
    type: assistant_interaction
    role: product_strategist
    modifiesFiles: false
    output: intake.md
  - id: questions
    name: Guided Questions
    type: discovery_questions
    role: product_strategist
    modifiesFiles: false
    output: transcript.md
  - id: synthesis
    name: Synthesis
    type: agent_output
    role: discovery_reviewer
    modifiesFiles: false
    output: discovery-summary.md
  - id: readiness
    name: Readiness Assessment
    type: agent_output
    role: scope_guardian
    modifiesFiles: false
    output: readiness-assessment.md
  - id: recommendation
    name: Recommendation
    type: agent_output
    role: scope_guardian
    modifiesFiles: false
    output: recommendation.md
```

`discovery-to-ticket/plan/patch/run` are **transitions** (API/CLI actions), not workflows — do not add them to the catalog.

## 6. CLI (phase D-7, in M1)

```bash
excalibur discovery "Add AI contract renewal reminders"
excalibur discovery --from-file feedback.md
excalibur discovery --from-linear ENG-123     # M4 — print honest "available in M4" notice
excalibur discovery --from-jira PROJ-123      # M4
excalibur discovery --from-github-issue 123   # M4
```

Behavior: pick mode (`--type <DiscoveryInputType>`, default `idea`; `--from-file` → `customer_feedback`), ask the pack's questions interactively (skippable with empty answer; `--yes`/non-TTY records unanswered), then score with `scoreDiscoveryTranscript`, recommend with `recommendFromScores`, synthesize artifacts via MockProvider (`metadata.kind` per artifact) and write everything to `.excalibur/discovery/<id>/` (id = `disc_YYYYMMDD_HHMMSS`). Print the readiness card and suggested next commands (`excalibur patch …`, `excalibur run …`) filtered by recommendation; if `do_not_build`, say so plainly. Local sessions are listed by `excalibur status --discovery`.

OSS behavior: no enterprise required, works locally, markdown output, can optionally create local patch/run **only if the user asks**, can sync later when connected.

## 7. Command parser additions (`@excalibur/work-items`)

Commands: `discovery` (with optional thread subcommands `complete|create-linear|update-ticket|create-run|save-decision`), `readiness`, `acceptance-criteria`, `split-scope` (`refine` already exists). `commandToAction` returns `{ kind: 'discovery'; action?: string }` for all of them except `refine` (which keeps its interaction mapping; Enterprise decides to open a DiscoverySession from it).

## 8. Design rules

Optional, lightweight, conversational, practical, source-aware, connected to tickets and runs, able to say "do not build", able to recommend validation before code. Discovery must never automatically create code changes — downstream actions only on explicit user choice, with a strong warning when recommendation is `do_not_build`.
