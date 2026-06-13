import type { DiscoveryInputType } from '@excalibur/shared';

/**
 * Discovery question packs (Discovery spec §2), keyed by `DiscoveryInputType`.
 *
 * Scoring in `@excalibur/shared` inspects the well-known question ids:
 * problem, user, current_workaround, urgency, mvp, out_of_scope, success,
 * evidence, risks, readiness. Packs may add more ids; scoring ignores them.
 */

export interface DiscoveryQuestion {
  id: string;
  text: string;
}

/** Base pack, reused by `incident`, `mvp_scope` and `other`. */
export const BASE_QUESTION_PACK: ReadonlyArray<DiscoveryQuestion> = [
  { id: 'problem', text: 'What problem are we trying to solve?' },
  { id: 'user', text: 'Who has this problem?' },
  { id: 'current_workaround', text: 'What do they do today?' },
  { id: 'urgency', text: 'Why does it matter now?' },
  { id: 'mvp', text: 'What is the smallest useful version?' },
  { id: 'out_of_scope', text: 'What is explicitly out of scope?' },
  { id: 'success', text: 'How will we know it worked?' },
  { id: 'evidence', text: 'What evidence do we have?' },
  { id: 'risks', text: 'What risks or unknowns remain?' },
  { id: 'readiness', text: 'Is this ready for implementation?' },
];

/** Product idea pack (`idea`). */
export const IDEA_QUESTION_PACK: ReadonlyArray<DiscoveryQuestion> = [
  { id: 'user', text: 'Who specifically has this problem?' },
  { id: 'problem', text: 'What painful workflow are they experiencing?' },
  { id: 'current_workaround', text: 'What workaround do they use today?' },
  { id: 'frequency', text: 'How often does this happen?' },
  { id: 'urgency', text: 'What happens if they do nothing?' },
  { id: 'impact', text: 'What is the buying, retention or activation impact?' },
  { id: 'mvp', text: 'What is the smallest useful version?' },
  { id: 'kill_criteria', text: 'What would make this not worth building?' },
];

/** Existing ticket pack (`work_item`). */
export const WORK_ITEM_QUESTION_PACK: ReadonlyArray<DiscoveryQuestion> = [
  { id: 'problem', text: 'Is the user/problem clear from this ticket?' },
  { id: 'acceptance', text: 'Are acceptance criteria present?' },
  { id: 'expected', text: 'Is the expected behavior clear?' },
  { id: 'repo', text: 'Is the target repository known?' },
  { id: 'dependencies', text: 'Are there dependencies or linked tickets?' },
  { id: 'out_of_scope', text: 'What is explicitly out of scope?' },
  { id: 'tests', text: 'What tests should pass?' },
  { id: 'readiness', text: 'Is this ready for implementation?' },
];

export const CUSTOMER_FEEDBACK_QUESTION_PACK: ReadonlyArray<DiscoveryQuestion> = [
  { id: 'verbatim', text: 'What did the customer actually say?' },
  { id: 'problem', text: 'Is this a request, a symptom or a real problem?' },
  { id: 'segment', text: 'What segment does this customer belong to?' },
  { id: 'evidence', text: 'How many customers have mentioned this?' },
  { id: 'current_workaround', text: 'What workaround do they use today?' },
  { id: 'impact', text: 'Is this blocking purchase, activation or retention?' },
  { id: 'validation', text: 'What cheap validation could we run?' },
];

export const TECHNICAL_INITIATIVE_QUESTION_PACK: ReadonlyArray<DiscoveryQuestion> = [
  { id: 'problem', text: 'What technical problem are we solving?' },
  { id: 'urgency', text: 'What happens if we do nothing?' },
  { id: 'driver', text: 'Is this reliability-, cost-, security- or productivity-driven?' },
  { id: 'systems', text: 'What systems are affected?' },
  { id: 'mvp', text: 'What is the smallest safe change?' },
  { id: 'success', text: 'What tests or metrics would prove success?' },
  { id: 'risks', text: 'Does this require migration, rollback or feature flags?' },
  { id: 'reviewer', text: 'Who should review this?' },
];

export const AGENT_READINESS_QUESTION_PACK: ReadonlyArray<DiscoveryQuestion> = [
  { id: 'problem', text: 'Is the goal clear enough for an agent?' },
  { id: 'acceptance', text: 'Are acceptance criteria present?' },
  { id: 'repo', text: 'Is the target repo known?' },
  { id: 'modules', text: 'Are affected modules known?' },
  { id: 'tests', text: 'Is there enough test coverage?' },
  { id: 'risks', text: 'Does it touch sensitive areas?' },
  { id: 'mode', text: 'Should AI only plan, propose a patch, or implement?' },
  { id: 'approval', text: 'Is human approval required before implementation?' },
];

/**
 * Question packs per Discovery input type. `incident`, `mvp_scope` and
 * `other` reuse the base pack; `work_item` uses the existing-ticket pack;
 * `idea` the product-idea pack.
 */
export const DISCOVERY_QUESTION_PACKS: Record<
  DiscoveryInputType,
  ReadonlyArray<DiscoveryQuestion>
> = {
  idea: IDEA_QUESTION_PACK,
  work_item: WORK_ITEM_QUESTION_PACK,
  customer_feedback: CUSTOMER_FEEDBACK_QUESTION_PACK,
  technical_initiative: TECHNICAL_INITIATIVE_QUESTION_PACK,
  incident: BASE_QUESTION_PACK,
  agent_readiness: AGENT_READINESS_QUESTION_PACK,
  mvp_scope: BASE_QUESTION_PACK,
  other: BASE_QUESTION_PACK,
};
