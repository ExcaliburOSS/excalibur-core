# Changelog

All notable changes to Excalibur Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.10.0] - 2026-07-02

Excalibur acts instead of asking. A new proactivity-above-all directive and a deterministic
"show me the site" route mean a request to review-and-serve the web reads the code itself and
serves it, instead of dumping a read-only analysis. Public Beta.

### Added

- **Proactivity above all.** A new top-level directive in every agent role's system prompt: the
  agent resolves questions and sub-goals ITSELF with its tools (reads the file, runs the
  command, investigates) and never asks you for anything it could obtain itself; it never ends
  with "open questions" it could have answered by reading or running something; any analysis is
  an internal means, not the deliverable — it does not hand you a report when you asked it to DO
  something; and when you ask it to show/serve/run something, it actually does it and gives you
  the URL. Previously this guidance was skipped entirely for read-only roles, so a "review the
  web" turn behaved passively.
- **"Show me the site" now serves it (deterministic `preview` route).** A new `preview` intent
  recognizes "show me the web", "enséñame la web", "run it", "revisa la web y enséñamela" and
  routes to the agent loop — which reads your code itself, reviews it if asked, and serves it on
  localhost with the `preview` tool — instead of the read-only analysis path that could not
  serve. It runs with the full living rail (pulsing active steps, shimmer, nesting, a persistent
  input box). Verified end-to-end: a review-and-show request reads the project files itself and
  serves the site; when the port was busy it fixed the server to a dynamic port on its own
  rather than asking.

## [1.9.0] - 2026-07-01

Excalibur reaches for the multi-agent swarm much more often, and the m-shell now shows you
the plan before it builds. Public Beta.

### Added

- **The plan is now VISIBLE before a build.** When Excalibur auto-orchestrates a build it
  decomposes the work into independent workstreams; until now that decomposition was used
  silently to size the swarm and you never saw it. The conversational shell now renders a
  bordered plan card — each workstream as a pending node with its parallel/dependency marker,
  the chosen shape (swarm vs single), and any sensitive areas — right before it starts. It is
  **non-blocking by design** (minimum friction): it shows the plan, then proceeds, and you can
  steer or cancel at any time with `Esc` or by typing.
- **Aggressive proactive orchestration (ORCH1).** Excalibur now fans work out to read-only
  explorers and parallel implementation lanes far more readily: exploration runs on the
  standard build/edit paths (medium and large tasks, not just large), the decomposition splits
  into ≥2 independent lanes whenever the work touches multiple files/modules, and per-wave
  verification defaults on when the project has a test command. All existing safety rails are
  kept (8-agent cap, one-core headroom, depth ≤ 1, isolated worktrees, the approvals/read-only
  floors). Verified end-to-end: a three-file task fans out into a real three-lane parallel
  swarm.

### Fixed

- **The mid-run input box now matches the idle prompt.** While a build runs, the input box
  caret now BLINKS on/off to mirror the terminal's native cursor, and the box spans the full
  terminal width (it could previously collapse to 80 columns). The accent colour already
  matched on the default theme.
- **No input frame is left behind in scrollback.** Submitting a message now tears down the
  entire framed input box — including the top accent hairline — and re-commits only your clean
  message line, so the conversation reads naturally with no orphaned coloured line.
- **A build can never appear stuck on "understanding".** The read-only pre-scan that grounds
  the decomposition is now bounded by a hard timeout (45s, overridable via
  `EXCALIBUR_PRE_SCOPE_TIMEOUT_MS`): if it runs long it is aborted and the build proceeds
  anyway, so a slow scan never blocks the build.

## [1.8.14] - 2026-07-01

The m-shell never exits on its own after a build, applies changes in-shell (no external
`excalibur apply`), and reliably serves the web locally. Public Beta.

### Fixed

- **RUN-FIX-25 — the m-shell never exits after a gated build.** On a GATED conversational
  build (approvals not auto), the Ink approval rail owns stdin; on teardown the handoff back
  to the raw line editor produced a spurious `null` read, which the REPL treated as a genuine
  Ctrl-D → it broke the loop → `return 0` → the RUN-FIX-24 supervisor (clean-exit branch) also
  exited → the shell silently dropped back to the OS prompt (100% of the time, with no error).
  The raw editor now distinguishes a DELIBERATE close (double-Ctrl-C / teardown) from a bare
  Ctrl-D / spurious EOF: the REPL breaks its loop on a null read ONLY when the user
  deliberately closed it — otherwise it re-arms and re-prompts. The shell now exits ONLY on an
  explicit `/exit` or a deliberate double-Ctrl-C. Proven by a deterministic raw-editor test.
- **The m-shell applies changes in-shell — no external `excalibur apply`.** A conversational
  build writes files DIRECTLY to your working tree, but the receipt still told you to run
  `excalibur apply run_<id>` (an external CLI command) because the next-step hint only counted
  an explicit patch-apply event, not the direct writes. It now recognizes direct writes as
  already-in-the-tree and shows an in-shell next step (“already applied — review with
  `/changes`”), never a CLI apply command.
- **“Show me the web” reliably serves it locally.** Strengthened the `preview` tool so it is
  used whenever you build/fix a web app AND whenever you simply ask to see/run/serve it, and
  made explicit that a server must NEVER be started with `run_command` (`node server.js &`) —
  those get reaped when the command settles; `preview` keeps it up for the session.

## [1.8.13] - 2026-06-30

The m-shell is now **structurally uncrashable**, and the input box stays put for the whole
turn. Fixes the long-standing "se cierra al arrancar el servidor web" crash and the input
that disappeared during a build.

### Fixed

- **RUN-FIX-24 — the uncrashable supervisor.** The interactive shell kept dying (~intermittently)
  during a build that starts a web server (`node server.js &`) — an **uncatchable** death
  (a `SIGKILL`/native crash for which `process.on('exit')` never fires) that no in-process
  guard can survive. The real session now runs in a CHILD process supervised by a thin
  parent that **respawns it (resuming the session) on any abnormal death** — signal, native
  crash, or OOM — so from the user's seat the shell never disappears: it blinks and comes
  back with the conversation intact («⟳ el shell se cayó y lo he recuperado»). The supervisor
  shares the terminal + process group (so Ctrl-C still reaches the foreground child) and
  ignores stray signals itself; a clean `/exit`/EOF/double-Ctrl-C exits without respawning.
  Opt out with `EXCALIBUR_NO_SUPERVISOR=1`. Proven by a deterministic self-`SIGKILL` →
  recovery test (`scripts/verify-supervisor.mjs`).
- **RUN-FIX-23 — the input box is permanent across the whole turn.** The mid-run input box
  (InterruptBox) flickered away at the start of execution and again between the build and
  the self-heal pass, because each sub-run mounted/unmounted its own rail. The conversational
  build now mounts ONE rail for the whole turn and renders every run (build + every self-heal)
  into it, so the input box stays present the entire time — verified present DURING a real
  build (`scripts/verify-mshell-real-landing.mjs` now asserts it).
- Opt-in exit forensics (`EXCALIBUR_DEBUG_EXIT`) now also instruments `process.kill` and flags
  any call that targets the shell's own process/group — the diagnostic that pinned the crash
  as an uncatchable, external death.

## [1.8.12] - 2026-06-30

The agent can now fan out read-only explorer sub-agents on demand — the high-frequency,
low-risk multi-agent pattern that speeds up almost any task.

### Added

- **`investigate` — agent-callable parallel read-only exploration.** A new tool lets the
  model fan out READ-ONLY explorer sub-agents in parallel (reusing the scope engine:
  decompose → explore each angle → synthesize) and get back a map of the subsystems
  involved, what already exists vs is missing, the relevant files, risks and open
  questions — without writing, patching or running anything. This is the
  read-only-exploration multi-agent pattern (distinct from the mutating build swarm in
  1.8.11): it's safe to call any time, for a task of ANY size, and keeps the main agent's
  context focused by reading many areas at once instead of a long sequence of single
  reads. The fan-out is bounded tighter than the explicit `/scope` command (its nested
  explorer calls don't count against the run's hard budget cap, like `verify`/`review`),
  and it refuses gracefully when no real model is configured.

## [1.8.11] - 2026-06-30

The conversational build now fans out into a visible parallel multi-agent swarm when the
work is decomposable and autonomy allows (#252), and the agent can persist project memory
itself (#253).

### Added

- **Proactive multi-agent in the conversational build.** A normal build/edit used to run
  as a single agent because the `edit` intent went straight to the sequential builder,
  bypassing the auto-orchestrator. It now routes through the SAME `dispatchAutoBuild` the
  swarm/plan intents use — when the autonomy posture would auto-run a swarm, it decomposes
  the task and, for ≥2 independent workstreams, fans out into a VISIBLE parallel swarm
  (each agent in its own worktree, verified + merged). At standard/lower autonomy, or a
  single-workstream task, it stays the sequential gated build with no new prompts. This
  lives in the routing layer (intent + complexity), NOT a mid-turn tool, so the swarm runs
  at the turn's top level — never nested in an agent loop — and the decision is
  deterministic (a complexity gate), not the model's whim.
- **`remember` — the agent persists project memory itself.** A new agent-callable tool
  lets the model capture a durable project memory (a decision, convention or gotcha) so
  future runs are primed with it (Knowledge Compounding), inferring subject paths from the
  statement. A corroborating capture reinforces rather than duplicates. It is the read/
  light-write management-tool pattern, gated as a benign knowledge write (no code change).
  This closes the highest-value gap from the proactive-reachability audit; the remaining
  slash commands (`rewind`/`replay` interactive scrubbers, `fork`/`undo` destructive run
  surgery, `loop` user mode, `stats` redundant with the agent-callable `insights`) are
  intentionally user-only.

## [1.8.10] - 2026-06-30

The mid-run input box is no longer duplicated on every task, and run history is now
immutable and scrollable (RUN-FIX-22 part 2 — completing the m-shell build cluster).

### Fixed

- **The user input box is no longer left behind (duplicated) after every task.** The rail
  is rendered with Ink, which on `unmount()` re-renders the current tree and leaves that
  final frame in scrollback. That final frame held the live InterruptBox + status footer,
  so each finished task (and each self-heal repair run) ghosted an input box + footer
  above the next prompt. The rail now `finish()`es before unmount — RunView drops ALL live
  chrome (input box, status line, live tail) and Ink repaints a clean frame — so
  scrollback keeps only the immutable transcript, never a stray input box.
- **Run history is immutable and scrollable — nothing is erased.** A completed phase used
  to keep only its header in scrollback; its narration, actions and diff were dropped (the
  "se borra el histórico" report). A finished phase now commits its FULL tail — every
  narration line, action and the finalized diff peek — into Ink's `<Static>` scrollback,
  so you can scroll up and see exactly what happened. Because this lives in scrollback and
  not the height-capped live region, it cannot trigger the live-region scrollback-erase,
  and an event is rendered in either the committed transcript or the live tail, never both
  (no double-render, no flicker).

## [1.8.9] - 2026-06-30

The m-shell can no longer exit on an execution error — the real, structural fix — plus
the model's raw reasoning never leaks to the screen, and the mid-run input box matches
the idle prompt (RUN-FIX-22, part 1). The input-duplication and history-immutability
parts of RUN-FIX-22 follow in the next release.

### Fixed

- **The interactive shell can NEVER exit on an execution error — proven.** Root cause
  found at last: the per-turn `try/catch` only opened AFTER the natural-language
  classify/routing region, so an exception there — a sync disk write failing (ENOSPC /
  EACCES after a build wrote many files), or any awaited rejection from a degraded
  provider in the seconds right after a heavy build — was NOT delivered as an
  `unhandledRejection` (the process-level net never saw it); it unwound the REPL loop into
  the teardown `finally` and the process exited. This was the "100% of the time, at the
  end of a build" crash. The ENTIRE per-turn body (classify → routing → dispatch →
  self-heal → settle) is now wrapped in one recover-and-continue backstop: on ANY fault it
  surfaces the error and re-prompts — the shell stays alive. A deterministic regression
  test injects a between-turn fault and asserts the session survives to `/exit` (it fails
  without the backstop). Defense-in-depth: a stray escaped fault no longer maps to a
  non-zero exit code; the rail teardown swallows its own `unmount`/`resumeInput` throws
  (and always returns stdin to the editor); and a single Ctrl-C in a sub-prompt
  (`/models`, onboarding, plan-shaping) cancels the prompt instead of killing the shell.
- **The model's raw reasoning never leaks to the screen.** Some models inline their
  chain-of-thought into the content stream as `<antThinking>…</antThinking>` /
  `<thinking>` / `<reasoning>` blocks (there is no separate reasoning channel on the
  OpenAI-compatible delta), and sometimes prefix prose with a stray status glyph. A new
  `stripReasoning` removes all of it — at the adapter source (live + committed) AND
  defensively at the TUI render boundary — streaming-safe (a dangling/partial tag is
  hidden so nothing flashes) and tag-name-anchored (ordinary `<` in prose is never
  clipped). The narration guidance also now forbids emitting thinking tags and reaffirms
  the user's language.
- **The mid-run input box matches the idle prompt.** The caret is now a STATIC accent
  block — the same steady sword-blue as the idle prompt's cursor — instead of breathing
  along the accent ramp (which made it look a different colour from the rules around it).
  When empty, the caret sits at the START, ready to type (it used to trail after the
  hint), and the placeholder uses the fainter `rail` token + dim attribute so it reads as
  a tenue hint, not already-typed text.

## [1.8.8] - 2026-06-29

A streamed build can no longer freeze, the live rail no longer flickers, and Excalibur
now serves the web app it just built on a local URL (RUN-FIX-21).

### Fixed

- **A streamed model call can never freeze a build again.** Until now the per-request
  timeout only guarded the initial connect — once tokens started flowing (or the model
  "thought" forever before the first token) there was no timeout, so a stalled stream
  hung `for await` indefinitely and the build sat there with no output, no spinner, no
  explanation. Streaming now races every pulled chunk against an idle timer: if no delta
  arrives within the idle window the connection is aborted instead of hanging forever.
- **Transparent retry of a pre-first-token stall.** When the stream stalls _before_ the
  model emits anything (the dominant freeze), the whole call is restarted automatically
  (up to the provider's retry budget) — nothing has reached you yet, so it is safe to
  replay. Once a delta has been shown, a later stall surfaces as a clean timeout and the
  build self-heals/errors rather than freezing. Caller cancellation is never retried.
- **The live rail no longer flickers.** The run view was re-folded from scratch on every
  120 ms animation tick (a fresh model object each frame forced a full repaint). The fold
  is now memoized on the event revision, with only a cheap elapsed-time overlay updating
  per frame — the rail animates smoothly instead of strobing.

### Added

- **`preview` — Excalibur serves the web it builds.** After building or fixing a web app
  the agent starts a local dev/preview server and hands you the URL to open. It runs the
  project's own `dev`/`start`/`serve`/`preview` script when there is one, or a built-in
  zero-dependency static server for a bare `index.html`. The server stays up for the
  session (it is not reaped like a one-shot command) and is cleanly stopped on exit, so
  nothing is left running behind the shell.

## [1.8.7] - 2026-06-29

The m-shell is now structurally UNCRASHABLE, the rail stops erasing history, and a few
graphic/UX glitches are fixed (RUN-FIX-19 + RUN-FIX-20).

### Fixed

- **The interactive shell can no longer terminate on a fault OR a signal — `el shell
no puede crashear NUNCA`.** Beyond the async-fault net, the m-shell now ARMORS itself
  against the termination signals that would otherwise kill the process mid-session
  (SIGTERM / SIGHUP / SIGQUIT) — it catches them, surfaces a calm notice, and stays
  alive. The editor's per-prompt signal handlers are neutered while armored so they
  can't exit over it (one-shot subcommands still terminate on a signal, as scripts
  expect). The only ways out are now explicit user intent (`/exit`, a double Ctrl-C) or
  an uncatchable `SIGKILL`. Proven deterministically: the shell survives SIGTERM, SIGHUP
  and SIGQUIT and keeps reading input (`scripts/verify-mshell-armor.mjs`, no model
  needed). Opt-in exit forensics (`EXCALIBUR_DEBUG_EXIT=<file>`) record the exact cause
  of any termination, so a stray exit is pinned in one line.
- **The rail no longer erases the history of what it already did.** The live (non-
  scrollback) region was only height-capping the diff; the todos band (one row per item,
  unbounded) and streamed narration could grow taller than the terminal and scroll Ink's
  dynamic region up over the completed-phase scrollback. The todo band is now WINDOWED
  (collapses the completed prefix into "⋯ N done", keeps the in-progress item visible,
  caps the rest), narration is clamped to a tail, and the input box's height is counted
  width-aware — so the live region can never exceed the viewport. The non-TTY logs keep
  the full list.
- **A backgrounded server (`node server.js &`) started by a verification is reaped, not
  orphaned.** `run_command` now kills the whole process tree on settle, so a check that
  launches a server never leaves it running behind the shell (which also removes a class
  of late-pipe faults), and detaches from the child's streams.
- **The internal self-heal prompt no longer leaks into the rail.** A typed-interrupt ack
  ("↻ Folding that into the current work …") was interpolating the raw current-work
  text, which during a self-heal is the long internal "Diagnose the ROOT CAUSE…" prompt.
  It is now clamped to a short single line.

### Added

- **The mid-run input box matches the idle prompt exactly** — two full-width accent
  rules, a breathing cursor inside, and the `◆ autonomy · permissions` indicator row.
- **The active task breathes** (pulsing dot + a left→right light crest on its text).
- **Cost is dropped from the conversational telemetry** (it was effectively always
  `$0.00` on the local/free paths — pure noise).

### Changed

- When the agent is genuinely blocked by an ELEVATED/root permission, it now gives the
  user the exact command **prefixed with `!`** (e.g. `!sudo chown -R "$USER" .`) so they
  can run it inline in the m-shell without ever leaving it — never "open another
  terminal", never loop.

## [1.8.6] - 2026-06-29

The m-shell can NEVER exit on a fault, the input is always visible, and the active
task breathes (RUN-FIX-17 + RUN-FIX-18).

### Fixed

- **The interactive shell can no longer exit on an execution fault — `nunca es nunca`.**
  Two non-exception exit paths that bypassed the process-level crash net are closed.
  (1) The prompt read itself (`editor.question` → paint → the framed header/footer and
  contextual-placeholder closures → the terminal write) ran _outside_ any per-turn
  try/catch; a throw there — a cosmetic paint fault, an `EPIPE` on a half-closed
  terminal, a closure reading transient runtime state after a long build — unwound out
  of the REPL loop and tore the shell down. The read is now wrapped (recover + re-prompt)
  and every paint closure + terminal write is individually guarded, so a render hiccup
  can never propagate. (2) A throw inside a keypress handler used to _close_ the editor
  and resolve the pending read with `null`, which the loop read as Ctrl-D/EOF and exited
  on. It now resolves with a dedicated recover sentinel (the editor resets and stays
  open) — a transient input fault is never mistaken for end-of-input.
- **A backgrounded process (`server &`) no longer hangs a command to the 120s timeout.**
  `run_command` settled only on full stdio EOF, but a backgrounded grandchild inherits
  and holds the pipes open, so EOF never came — the run stalled for two minutes (the
  "se queda un rato" freeze that preceded the crash). It now settles on the direct
  child's exit (with a short grace to flush the last output) and returns promptly.
- **An aborted command can never SIGKILL the m-shell itself.** The process-group kill
  now requires a strictly-positive pid (`-0 === 0` in JS, and `process.kill(0, …)`
  signals the caller's own group), so a stray `0`/`NaN` pid turns into a no-op instead
  of suicide.

### Added

- **The input is ALWAYS visible while a build/mission runs.** A persistent prompt sits
  at the foot of the live rail — when idle it shows a dim hint + cursor, and it fills
  with your draft as you type — so the user input never visually disappears mid-run.
- **The active task breathes.** The in-progress checklist item pulses its dot along the
  accent ramp and sweeps a left→right light crest across its text (matching the active
  phase header), so there is real movement on what Excalibur is doing right now.

## [1.8.5] - 2026-06-29

You can type WHILE a build or mission runs (RUN-FIX-16).

### Added

- **Typing during execution.** While a gated build or a mission is running, the input
  stays live at the foot of the rail — type and your message is composed as a draft,
  then triaged the moment you press Enter by the same interrupt brain the chat turns
  use: **stop** aborts the run; an **independent** request spins off as a parallel
  `/bg` thread right away; a **quick question** is answered inline without pausing the
  run; and a **refinement** of the current work is queued (FIFO) and runs the instant
  the current run finishes, with its result as context. Previously the keys were inert
  while a run held the rail — the input appeared to vanish. Wired into both the build
  engine (`run-pipeline`) and every mission step.

## [1.8.4] - 2026-06-29

The m-shell is now genuinely uncrashable, more autonomous, and the rail is cleaner
(RUN-FIX-15).

### Fixed

- **The shell can NEVER exit on an error — for real, this time.** 1.8.3's safety net
  caught escaped async faults, but an error thrown from the _synchronous_ post-turn
  path (`settleInterruptAftermath`, the pre-prompt banners/rule, the status line) ran
  OUTSIDE the per-turn try/catch and escaped the loop → teardown → exit. Every
  out-of-turn region in the REPL loop is now contained: a failure surfaces and the
  prompt always comes back. The shell only exits on an explicit quit/EOF.
- **Maximum autonomy, minimal asking.** The agent is now told to solve everything it
  possibly can itself and ask the user ONLY when something is genuinely impossible
  alone — and to try real workarounds first (a non-writable cache → a writable temp
  dir, a dirty install → clean reinstall) before concluding it's blocked. It escalates
  only for elevated-rights/machine-level actions it cannot take (chown needing sudo,
  a system package, a missing credential), and then gives the EXACT command to run —
  instead of looping on the same failing command.

### Changed

- **The rail is cleaner.** Removed the partial-width gray hairline rules above the
  status footer (rail) and the receipt — on a wide terminal a short `─` cut line read
  as broken. Dropped the duplicate blank line before a gated build (one blank max,
  set at the dispatch point).

## [1.8.3] - 2026-06-28

Robustness + clarity. The m-shell can no longer be killed by an execution error,
it fixes failing checks itself instead of delegating, and the rail is clearer
(RUN-FIX-13 + RUN-FIX-14).

### Fixed

- **The interactive shell can NEVER be crashed by an execution error.** A stray
  async fault deep in a run (a child-process error, an `EPIPE`, an unhandled
  rejection) used to take Node — and the whole m-shell — down with it. A
  top-level safety net now contains any escaped fault, surfaces it calmly, aborts
  only the in-flight turn, and keeps the session alive.
- **Excalibur fixes failing checks itself.** When a build's verification comes
  back red, the shell now drives a bounded, focused self-heal run (diagnose the
  root cause → fix → re-verify) instead of stopping and telling you to fix it.
  The receipt hint is an honest status ("the checks above are still red"), never
  a "you fix it" delegation.
- **Every turn is spaced from your request — for real this time.** The blank line
  now sits at the single dispatch point, so a gated **build** or a **mission**
  (which mount different presenters than the conversational rail) get the same
  air the chat turns already had. Mission steps breathe apart, and the mission
  intro ("Interpreting your goal…") is localized, no longer hardcoded English.
- Approvals on the **gated-workflow** path (and `excalibur run`) now persist their
  real question + decision too (the reducer reads `message`/`question`), and a
  finished/aborted run no longer renders a stale, unanswerable approval prompt in
  its replay.

- **Inline diffs are always unified now** — stacked − lines then + lines, all
  left-aligned, full width. On a wide terminal the inline diff used to split into
  old-left / new-right columns (and additions floated to the right with an empty
  left column when there were no deletions); the live Ink rail now matches the
  string rail and never does that. The word-level highlight, teal/coral tints and
  gutter are unchanged. (`renderDiff`'s side-by-side layout stays available to
  other callers.)
- **Tool approvals persist in scrollback.** When Excalibur asks to run or edit
  something, the question **and your answer** ("…? → approved/declined") now stay
  as a permanent line in the conversation instead of vanishing the instant you
  answer. Recorded as real run events, so a replay shows them identically.

### Changed

- **Workflow phase headers are descriptive, not a bare word.** Each gated-workflow
  phase carries a present-continuous `gerund` shown next to its name while active
  — "Context Discovery · reading the codebase to map what already exists",
  "Implement · writing the change and keeping the project building", etc. — so a
  20-second phase reads as a sentence about the work instead of a single static
  label. (Deeper live per-phase narration in your language is the next step.)

## [1.8.2] - 2026-06-28

Conversational-turn UX overhaul (RUN-FIX-12) — space, life, warmth, and a chrome
that follows your system language.

### Fixed

- **Spanish (and other) chrome auto-detected from the OS.** A Spanish macOS that
  launches a shell with `LANG=C.UTF-8` (or unset) now gets Spanish chrome instead
  of falling back to English — `detectCliLocale` consults the OS preferred
  language (`AppleLocale` on macOS, `Intl` elsewhere) when the environment is
  neutral. Gated to an **interactive terminal**, so scripted/piped/CI runs stay
  deterministic and an explicit `LANG`/`EXCALIBUR_LANG` always wins.
- **The turn breathes.** A blank line now separates your request from Excalibur's
  reply, and every spoken paragraph floats on its own line — no more
  line-on-line wall of text.

### Changed

- **A pulsing `●` leads every spoken line.** The live narration is marked by
  Excalibur's signature accent dot, breathing along the accent ramp as it
  streams — distinct from the `│`-railed mechanical action lines.
- **Warmer, more human voice.** The narration guidance and the plan-shaping /
  discovery question prompts now ask the model for a genuinely friendly,
  teammate-like tone that addresses you directly and informally (Spanish: «tú»,
  never the cold «usted»/«desea»), and opens each turn by echoing back what you
  asked. The plan-shaping prompts themselves were reworded from terse
  ("Include in the plan?") to inviting ("Which of these should I weave into the
  plan?").
- **The multi-select repeats the confirm cue below the options** — a
  `⏎ Press Enter to confirm (N selected)` line where the eye lands after
  scanning the list, not only above it.

## [1.8.1] - 2026-06-28

Input-box rendering fixes (the framed prompt from 1.8.0).

### Fixed

- The top/bottom accent rules now span the **full terminal width** in solid
  accent colour (they were a short fixed-width stub), and re-span instantly on a
  terminal **resize**.
- The framed box now wraps **only** the live input — the rules are drawn by the
  editor as one unit, so scrollback (the dashboard banner, conversation) stays
  ABOVE the box instead of being trapped inside it.
- The m-shell's auto-started dashboard prints the accent-branded
  `◆ Excalibur Live Dashboard: <url>` banner (matching `excalibur serve`), as
  scrollback above the box.
- The indicator row under the box drops the model/provider and shows the useful
  key shortcuts (`/ commands · ? help · ⇥ threads · ↓ log`) alongside the
  autonomy + permissions.

## [1.8.0] - 2026-06-28

The **proactive primary-surface** release. The m-shell is Excalibur's primary,
most-advanced surface (we benchmark against the shells, Claude Code and OpenCode);
the `excalibur <command>` binaries are its scriptable projection, not a separate
tier. This release closes that gap in both directions: every management command is
reachable **in** the shell, and — more importantly — the agent now uses Excalibur's
own capabilities **on its own**, mid-conversation, without you typing a command.

### Added

- **Proactive management tools.** The agent can pull real project state into its
  reasoning through 11 read-only native tools it calls itself when the situation
  calls for it — `project_status`, `work_items`, `sprint_status`, `plans`,
  `insights`, `run_logs`, `list_agents`, `list_skills`, `sessions`, plus `verify`
  and `review` (which hand back the redacted working-tree diff framed for the agent
  to self-check in its own budgeted loop). Wired into the conversational turn, the
  gated build, and headless runs (serve / acp / scheduler). Real-Kimi verified: the
  model calls `project_status` on its own to answer "where do things stand?".
- **Management commands first-class in the m-shell.** `/work-items`, `/sprints`,
  `/plans`, `/verify`, `/review`, `/mission`, `/orchestrate`, `/schedule`, `/scope`,
  `/status`, `/stats`, `/logs`, `/insights`, `/agents`, `/skills`, `/session` each
  run the IDENTICAL command `excalibur <name>` runs, in-process — surfaced in the
  `/` menu and `/help` (en + es).
- **Framed input box.** The shell prompt is bracketed by accent hairlines with a
  compact indicator row (`◆ model · autonomy · preset · auto · ? help`).

### Changed

- **Ctrl-C / ESC contract.** Ctrl-C cancels in-flight work and returns to the
  prompt — it never kills the shell while something is running. ESC cancels the
  whole mission / orchestration (not just the current step). Exit stays explicit
  (`/exit`, Ctrl-D, or double-Ctrl-C on an empty prompt).
- Suspend/resume of the shell editor is now reference-counted, so a nested command
  (a `/mission`'s per-step Ink views) can't re-arm the editor mid-command.

### Fixed

- A live run no longer renders a successful turn as a red error, never shows
  `exit 0`, peeks the diff by default, and the in-progress action/phase header
  shimmers — carried over and polished from the live-rail work.
- `schedule run` (an unbounded daemon) is kept out of the in-shell passthrough and
  no longer leaks its signal listeners.

## [1.7.0] - 2026-06-27

The **shell-parity & live-rail polish** release. The headline: the conversational
m-shell is now a _friendlier interface to the SAME engine_ as the direct
commands — a build you type in the shell runs the full **gated workflow** (the
complexity-sized Plan → Implement → **Verify** → **Review** → PR phases, the
adversarial **verification mesh** and the **claim ledger**), exactly like
`excalibur run`, never a degraded single loop. Plus a wave of fixes to the live
run rail and the post-turn receipt.

### Added

- **The m-shell runs the gated workflow engine.** A build (or a single direct
  code change) typed into the interactive shell now flows through the same
  `selectWorkflow → executeLocalRun` pipeline as `excalibur run`: the
  complexity-sized workflow, its Verify/Review phases, the verification mesh and
  the claim ledger all run — wrapped in the conversational rail, live narration,
  inline approvals and the warm receipt. Previously a shell build ran a bare
  single agent loop with no phases or gates. Real-Kimi verified end to end
  (`scripts/verify-mshell-gated.mjs`).
- **New `edit` intent.** The intent router now distinguishes a pure question
  (`chat`, a conversational turn) from one small direct code change (`edit`,
  routed through the gated engine) — so even a quick change in the shell gets the
  same tests/typecheck/verify quality as the CLI.
- **Default engineering-quality bar in the agent prompt.** Every build now holds
  to a production bar by default: real project structure with concerns separated
  into their own files/modules (not one monolithic blob), idiomatic code,
  accessible/usable UX, and _verify it actually builds/runs_ before declaring
  done. Real-Kimi verified ("build a landing page" now yields a structured
  `index.html` + `styles/` + `scripts/`, not a bare inline file).
- **Animated live rail.** The in-progress action and the active phase header
  pulse an accent crest left→right (Claude-Code-style), so the live line reads as
  "happening now".

### Changed

- **Diffs peek by default.** The most-recent change shows the first lines of its
  diff inline (up to ~25, capped to the terminal height) instead of a "press
  space to expand" stub.
- **The live "Working" tail collapses.** The active phase shows only its
  most-recent actions behind a "⋯ N earlier" indicator, so the breathing header
  never scrolls off the top — and the header reads warmly ("Working on your
  task…") rather than a bare "Working".

### Fixed

- **A successful turn no longer renders as a red error.** A backgrounded dev
  server (`… &`), a user-denied/skipped command, an interrupt/terminate signal,
  or an unknown exit code is no longer mistaken for a failed check that flipped
  the whole turn to a red ✗. Genuine failures (incl. crash signals) still fail.
- **"exit 0" is never shown** — a green ✓ already says the command passed.
- **The live region no longer erases the scrollback above it, and the TUI no
  longer flickers** — both were the same Ink "dynamic region taller than the
  viewport" bug, fixed by bounding the live region to the terminal height.

## [1.6.0] - 2026-06-27

The **planning overhaul** release: Excalibur's plans go from prose to a
structured, durable, trackable, recallable artifact — world-class for very large
multi-phase projects — and the live dashboard gains the plan tree, the agile
backlog, and the sprint burndown.

### Added

- **Structured plans (source of truth).** An approved plan is now a structured
  model — phases → steps with per-step status, dependencies, and acceptance — saved
  as a `<id>.plan.json` sidecar alongside the human `.md`. Everything below builds
  on it.
- **Durable resume-at-step.** A large multi-phase plan executes step by step, each
  step checkpointed to disk, so an interrupted run (Ctrl-C, a crash, closing the
  laptop) resumes at the next unfinished step instead of redoing everything. The
  shell proactively offers to pick an unfinished plan back up at launch, and
  `excalibur plans resume [id]` resumes on demand.
- **Live plan tree.** A breathing plan ribbon is pinned above the run rail in the
  TUI (phases → steps with live status and a done/total roll-up), and the dashboard
  Plans view renders the same tree with a progress bar, a "next step" marker, and a
  "resumable" badge.
- **Plans become work-items.** Approving a plan materializes it into the kanban: the
  plan becomes an **epic**, each step a sub-task, and each step's dependencies become
  first-class **`blockedBy`** edges between work-items. The board live-tracks
  execution as steps run. `excalibur plans tasks [id]` materializes on demand.
- **Advanced backlog — sprints, estimates, burndown.** Work-items gain a story-point
  `estimate`; a new sprint store time-boxes work; `excalibur sprints`
  (list/create/start/complete/assign/show) drives it from the terminal with an ASCII
  burndown, and the dashboard adds a Sprints view with an SVG burndown chart.
- **Richer plan memory.** A finished plan now writes a structured, recall-friendly
  memory — outcome digest plus the **files it touched** as the relevance key — so an
  executed plan primes future work on the same files (the old capture was never
  recalled). Partial/blocked plans are remembered too.
- **Structured re-plan diff.** `excalibur plans diff [idA] [idB]` shows what changed
  between two plan versions — steps added/removed/renamed/moved — matched by title so
  an inserted step doesn't read as "everything after it changed".

### Changed

- **`excalibur serve` leads with the dashboard.** The startup banner now headlines
  the clickable dashboard URL in the Cobalt sword-blue accent
  (`◆ Excalibur Live Dashboard: <url>`).

## [1.5.0] - 2026-06-27

A conversational-shell + reach release: the agent can work across directories,
never leaves you watching a silent cursor, and the prompt gains a real command
menu.

### Added

- **Work across directories.** The agent is no longer confined to the working
  directory: `read_file` / `list_files` can read anywhere (a sibling project, an
  absolute or `../` path), and `write_file` / `edit` / a command's working
  directory can change other directories too. **Out-of-tree writes are confirmed
  first** at the permission gate (allowed on approval); secret files (`.env`,
  keys, credentials) are still refused and the destructive-command floor +
  `O_NOFOLLOW` leaf guard stay hard.
- **A `/` command menu.** Typing `/` lists every command with a brief
  description and filters as you type; ↑/↓ highlight a row and Tab/→ autocompletes
  it. Replaces the old model-powered ghost autocomplete.
- **A contextual placeholder** — a dim hint inside the empty prompt that adapts to
  context (a first-run invitation vs. a follow-up hint) and disappears as you type.

### Changed

- **Always-on narration.** A pulsing "thinking" indicator with rotating, friendly
  status phrases now covers every previously-silent wait (understanding the
  request, shaping a plan, mapping scope, breaking work into steps), and the
  narration guidance mandates continuous, plain-language narration — never a
  silent cursor.

### Fixed

- **The up-arrow no longer duplicates the line.** The raw line editor clears its
  full (wrapped) multi-row block on each repaint instead of a single row.
- More user-facing copy reworded from "run" to "task" / "execute the task".
- Removed a stray black line across the welcome sword's blade.

## [1.4.1] - 2026-06-27

A conversational-shell polish release — the m-shell now talks like a
pair-programmer, never leaks internal "run" machinery, and its intelligence can
no longer be silently disabled.

### Fixed

- **The shell's intelligence is never silently off.** Intent routing — the gate
  that sends a turn to plan / swarm / scope / mission instead of a plain turn —
  required a separate fast model; with a single model configured it quietly fell
  back to "always a plain turn", so scope estimation and plan-shaping never ran.
  It now falls back to the default model (with a reasoning-aware budget) so the
  routing always works. Verified across EN/ES/FR.
- **`exit` / `quit` leave the shell.** A bare `exit`/`quit` was treated as a task
  and handed to the model; it now exits, as in every REPL.
- **No stray git error on a fresh repo** — `fatal: ambiguous argument 'HEAD'` no
  longer leaks on a repository with no commits.

### Changed

- **The conversational turn leads with narration, not run scaffolding.** Dropped
  the `→ agent · act · L4` header, the internal run id/path line, and the
  `run completed` line from chat/plan/build turns — the warm narration, the live
  action lines (file paths + diffs stay) and the post-turn receipt carry it.
  Plan/build phases read as `◇ Planning…` / `◆ Making the changes…`.
- **Talk tasks, not "runs".** "run" is internal; user-facing output across the
  shell, the `run`/`patch` command and replay now says **task** (en + es).
- **Slimmer live footer in the shell** — just time · tokens · cost, dropping the
  level/safety/push/model telemetry (the `excalibur run` command keeps the full
  footer).
- **Status-line safety reflects the real posture** — when auto-accept is on it
  says so, instead of always claiming "no files will be modified without approval".

## [1.4.0] - 2026-06-26

The work-item dashboard minor — the local board becomes a real command center.

### Fixed

- **The local dashboard now serves the work-item board, not a legacy run page.** A
  symlink path-resolution bug meant every globally-installed CLI fell back to an old
  run-centric page; `excalibur serve` (and the m-shell's auto-dashboard) now reliably
  serve the embedded Svelte work-item kanban, with an honest "not built" page as the
  only fallback. The legacy inline run dashboard is removed.

### Added

- **A work-item command center in the local dashboard.** Create work items (a `+ New`
  panel and per-lane quick-add), edit them (title · description · lane · priority ·
  assignee · labels), delete, comment, and author a checklist (acceptance criteria /
  subtasks) — all from the UI, over a write-gated `/api/work-items` surface.
- **The m-shell's auto-started dashboard is now interactive** (writable), so you can
  manage work items and start runs right there. It stays localhost-bound + per-session
  token-gated; `EXCALIBUR_DASHBOARD=read-only` opts down, `=off` disables.

## [1.3.0] - 2026-06-26

The orchestration & autonomy minor: Excalibur now interprets a big goal, maps
the codebase before it plans, drives a multi-step mission to completion, and
lets you steer it live — while narrating the whole way.

### Added

- **Meta-orchestrator (missions)** — give Excalibur a large goal in plain
  language and it auto-composes a **capability DAG**
  (understand → plan → parallelize → explore → verify → ship), then drives it
  with an adaptive supervisor that re-plans as it learns, **checkpoint/resume**,
  and budget/time governance. Big goals engage it **proactively** (no command),
  with a live **plan ribbon** pinned above the run rail. Each capability is
  backed by the real engine — `parallelize` → the swarm, `explore` → best-of-N,
  `verify` → the Verification Mesh, `ship` → a real pull request — and its gates
  are grounded in real run events, not model prose.
- **Understand-first scope engine** — a read-only, auto-dimensioned exploration
  fan-out that maps a task (relevant files/subsystems, what exists vs. what's
  missing, risks and open questions) **before** planning or building. Available
  as `excalibur scope <task>` (`--json`/`--angles`/`--complexity`), as a natural
  `scope` intent, as a dashboard **Scope** view (`/api/scope`), and — the
  differentiator — **proactively** to ground plan-shaping's questions and the
  planner in real code on large tasks (opt out with `EXCALIBUR_AUTO_SCOPE=off`).
- **Plan-shaping** — before a large or unclear build, Excalibur asks a few
  clarifying questions and offers **multi-select recommendations** to co-create
  the plan (CC/Cursor-style), with the questions/recommendations tailored
  dynamically by the model and grounded in the scope map. Silent on small, clear
  tasks. Also surfaced as a dashboard panel.
- **Live interruptions** — type to Excalibur **during** a run: an interrupt
  triage classifies what you mean, an independence check decides parallel-vs-pause
  for a new request, a routing planner acknowledges instantly, and paused threads
  can be switched to and resumed.
- **Autonomous scheduler & proactive background** — schedule jobs on an
  interval, at a time, or by cron (`schedule` + a dashboard **Scheduler** view);
  the background fleet can **chain** (react-on-completion), a completion
  supervisor can react to a finished run, and background/scheduling are reachable
  by natural language, not just commands.
- **Conversational narration** — the agent narrates its work like a
  pair-programmer: warm, first-person, concise prose between actions, surfaced
  live in the run rail and **streamed token-by-token** as the model thinks
  (openai-compatible providers), with a graceful non-streamed fallback. Narrates
  in the user's own language.
- **Destructive-command safety floor** — catastrophic/irreversible shell
  operations (`rm -rf`, force push, `git reset --hard`, `git clean -f*`, `sudo`,
  `mkfs`, `dd of=/dev/*`, …) are hard-denied regardless of allowlist or approval,
  even under auto-accept/`--yes`. A deliberate per-command allowlist opt-in lifts
  it; a broad `*` does not.
- **Recoverable autonomous runs** — a dirty-tree nudge, a restore point, and a
  rollback hint so an unattended run is never a one-way door.
- **Dashboard, expanded** — new **Sessions** (read-only transcripts),
  **Scheduler**, background **Threads**, a per-run **detail + diff/patch
  viewer**, **global search** across runs and work-items, and a live **budget
  meter** with run-done / approval-pending notifications. Responsive/mobile
  layout, all on a shared read-only `--share` token surface.

### Changed

- **Cobalt theme** — a canonical sword-blue palette and motion vocabulary across
  the Ink TUI (cursor, status gauge, rail gradient) and the web dashboard, so the
  two surfaces match.
- **Context compaction overhaul** — fast-model default, background + silent
  auto-compaction, real-token trigger with reactive overflow→compact→retry, a
  `ctx NN%` status indicator, and a deterministic fidelity guard. Plus **in-turn
  compaction** so a single long agentic turn never overflows the context window.

### Security

- **Path-traversal hardening** on the dashboard detail routes — a percent-encoded
  `..%2F..` can no longer escape the sessions/plans/missions store dirs through
  the read-only share token (now rejected with `400`).

### Infrastructure

- **npm Trusted Publishing (OIDC)** — releases publish from a tag via a
  short-lived GitHub OIDC credential with provenance attestation; no long-lived
  `NPM_TOKEN` lives in the repo. Plus OSS hygiene: `SECURITY.md`, issue/PR
  templates, `CODEOWNERS`, Dependabot, and third-party license notices.

## [1.2.0] - 2026-06-21

### Added

- **External access (F1–F8)** — free, governed web access by default:
  `web_fetch`, `web_search` (local SearXNG → DuckDuckGo), a native multi-source
  research pipeline with cited/verified sources, an opt-in local browser for
  JS-heavy pages, hosted readers (BYOK), and first-class MCP (stdio + Streamable
  HTTP, OAuth/DCR, an Ed25519-signed server registry). All behind a network
  policy, an always-on SSRF floor, and prompt-injection scanning with provenance.
- **Onboarding overhaul** — arrow-key + type-ahead model picker (Kimi / MiniMax /
  GLM lead), paste-the-API-key (masked) into a `0600`
  `~/.config/excalibur/secrets.env`, zero-friction first run with an automatic
  connection test, and smart project-location handling (`excalibur new`,
  create-or-use-here when run anywhere).

## [1.1.0] - 2026-06-20

### Added

- **Background fleet** — `/bg <task>` runs a turn in its own recorded run while
  the prompt stays free (quiet, auto-approved; blocked paths still denied), with
  a one-shot banner on completion; `/threads` lists the fleet and the status line
  shows the active count.
- **Conversational intent router** — a natural-language line is routed to
  plan / swarm (offered) / background (offered) / a direct turn, with no arcane
  commands. Engages only with a real model on an interactive TTY at an
  act-capable level; goes direct under auto-accept and on piped/CI/mock paths.
  Opt out with `EXCALIBUR_ROUTER=off`.
- **Knowledge-compounding read side** — captured project memory (decisions,
  rejections, risks, conventions) is now re-injected into conversational turns,
  relevant to the working set and the paths named in the task.
- **CC-style run rule** above the prompt naming the running background run.
- Generated `.excalibur/instructions/*.md` are localised to the active locale
  (en/es); `AGENTS.md` stays English as a cross-tool standard.

### Changed

- **Redesigned welcome** — full-width accent frame, mixed-case `Excalibur` title
  with a blue→cyan gradient + dim version cutting the top border, the brand
  epigraph, and a crisp quadrant-pixel sword.
- **Autonomy now defaults to L4** (full agentic) — onboarding writes
  `autonomy.default: 4` and the runtime falls back to it.

### Fixed

- Under auto-accept the router goes direct, preserving the zero-prompts contract.
- A Prettier pre-commit hook auto-formats staged files so `format:check` can't
  fail on a missed `pnpm format` (developer experience).

## [1.0.0] - 2026-06-19

The first public release. Highlights of what Excalibur Core does today:

### Agentic core

- Real **model gateway** — `anthropic`, `openai-compatible` (incl. vLLM/custom),
  and `ollama` adapters, with streaming, real token/cost accounting, retries,
  timeouts, and secret redaction. A built-in deterministic **mock** provider is
  the zero-config, offline default.
- Real **native agent loop** — model→tool loop (read/write/search/run/patch/…),
  path-confined to the working directory, gated by the Permission Engine and
  inline approvals.
- **Swarm** fan-out/fan-in — independent subtasks run as parallel agents in
  isolated git worktrees, with a `--grade` revise-until-it-passes rubric loop.
- Per-session **Docker sandbox**, **LSP** per-edit diagnostics fed back to the
  agent, and **MCP** client (stdio + Streamable-HTTP) wired into the loop.

### Experience

- **Ink TUI** — a live, flicker-free run rail with inline syntax-highlighted
  diffs, themes (incl. daltonized / high-contrast), and live swarm lanes.
- **Time machine** — `rewind`/`replay` scrubber + fork-from-cache from any step.
- **Verification Mesh** + **Claim Ledger** — adversarial, evidence-linked quality
  gates over a run's changes.
- **Discovery**, **Knowledge Compounding** memory, structured workflows +
  methodologies, **ISD** instruction ingestion, **insights**, a read-only web
  dashboard (`serve`), and headless output (`run --output-format json`,
  `ask --json-schema`).
- Real **pull requests** via the GitHub CLI (`pr-create`), real GitHub work-items
  (`work-items`), and bilingual (en/es) CLI chrome.

### Notes

- Published to npm as
  [`@excalibur-oss/excalibur`](https://www.npmjs.com/package/@excalibur-oss/excalibur)
  — `npx @excalibur-oss/excalibur` (see [README](README.md)).
