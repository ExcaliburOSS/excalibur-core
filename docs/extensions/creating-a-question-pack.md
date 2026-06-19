# Creating a Question Pack

Question packs drive the guided-questions phase of the Excalibur Discovery
flow (`excalibur discovery`). A pack is a declarative YAML file — no code.

## 1. Write the YAML

```yaml
id: product-discovery
type: question_pack # optional in .excalibur/question-packs/, recommended
name: Product Discovery
description: > # optional
  Opinionated product-discovery questions for a B2B SaaS team.
questions: # at least one
  - id: user
    text: Which customer segment has this problem?
  - id: problem
    text: What painful workflow are they experiencing?
  - id: evidence
    text: How many customers asked for this in the last quarter?
  - id: kill_criteria
    text: What evidence would make us stop and not build this?
```

Both `id` and `text` are required on every question and must be non-empty.

## Question ids matter for scoring

Discovery scoring (`scoreDiscoveryTranscript` in `@excalibur/shared`)
inspects the **well-known question ids** to compute the readiness scores
behind the recommendation card:

```
problem, user, current_workaround, urgency, mvp,
out_of_scope, success, evidence, risks, readiness
```

Reuse those ids when your question covers the same ground (your wording can
be completely different). Extra ids — like `kill_criteria` above — are kept
in the transcript and the synthesis but do not feed the scores.

## The built-in packs

The `discovery-pack` built-in contributes one pack per Discovery input type
(`DiscoveryInputType`): `discovery-idea`, `discovery-work-item`,
`discovery-customer-feedback`, `discovery-technical-initiative`,
`discovery-incident`, `discovery-agent-readiness`, `discovery-mvp-scope`,
`discovery-other`. Their content lives in
`packages/workflow-schema/src/question-packs.ts` — a good source of question
style.

To replace a built-in pack, reuse its contribution id (e.g.
`discovery-agent-readiness`); to add a pack alongside the built-ins, pick a
new id.

## 2. Ship and validate

```bash
# Loose file:
cp product-discovery.yaml .excalibur/question-packs/

# Or scaffold a pack:
excalibur extensions create question-pack product-discovery

excalibur extensions validate
excalibur extensions list      # shows the question_pack contribution + source
```

Working example with two packs:
[`examples/extensions/declarative-discovery-pack`](../../examples/extensions/declarative-discovery-pack/).
