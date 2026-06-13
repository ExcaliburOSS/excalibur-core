import { describe, expect, it } from 'vitest';
import { discoveryInputTypeSchema } from '@excalibur/shared';
import {
  BASE_QUESTION_PACK,
  DISCOVERY_QUESTION_PACKS,
  IDEA_QUESTION_PACK,
  WORK_ITEM_QUESTION_PACK,
} from './question-packs';

describe('DISCOVERY_QUESTION_PACKS', () => {
  it('covers every DiscoveryInputType key', () => {
    const inputTypes = discoveryInputTypeSchema.options;
    expect(inputTypes).toHaveLength(8);
    for (const inputType of inputTypes) {
      const pack = DISCOVERY_QUESTION_PACKS[inputType];
      expect(pack, `pack for ${inputType}`).toBeDefined();
      expect(pack.length, `pack for ${inputType} must not be empty`).toBeGreaterThan(0);
    }
    expect(Object.keys(DISCOVERY_QUESTION_PACKS).sort()).toEqual([...inputTypes].sort());
  });

  it('reuses the base pack for incident, mvp_scope and other', () => {
    expect(DISCOVERY_QUESTION_PACKS.incident).toBe(BASE_QUESTION_PACK);
    expect(DISCOVERY_QUESTION_PACKS.mvp_scope).toBe(BASE_QUESTION_PACK);
    expect(DISCOVERY_QUESTION_PACKS.other).toBe(BASE_QUESTION_PACK);
  });

  it('uses the product-idea pack for idea and the existing-ticket pack for work_item', () => {
    expect(DISCOVERY_QUESTION_PACKS.idea).toBe(IDEA_QUESTION_PACK);
    expect(DISCOVERY_QUESTION_PACKS.work_item).toBe(WORK_ITEM_QUESTION_PACK);
  });

  it('keeps the base pack question ids in the spec order', () => {
    expect(BASE_QUESTION_PACK.map((question) => question.id)).toEqual([
      'problem',
      'user',
      'current_workaround',
      'urgency',
      'mvp',
      'out_of_scope',
      'success',
      'evidence',
      'risks',
      'readiness',
    ]);
  });

  it('keeps the idea and work_item pack ids per Discovery spec §2', () => {
    expect(IDEA_QUESTION_PACK.map((question) => question.id)).toEqual([
      'user',
      'problem',
      'current_workaround',
      'frequency',
      'urgency',
      'impact',
      'mvp',
      'kill_criteria',
    ]);
    expect(WORK_ITEM_QUESTION_PACK.map((question) => question.id)).toEqual([
      'problem',
      'acceptance',
      'expected',
      'repo',
      'dependencies',
      'out_of_scope',
      'tests',
      'readiness',
    ]);
  });

  it('keeps the customer_feedback, technical_initiative and agent_readiness pack ids', () => {
    expect(DISCOVERY_QUESTION_PACKS.customer_feedback.map((question) => question.id)).toEqual([
      'verbatim',
      'problem',
      'segment',
      'evidence',
      'current_workaround',
      'impact',
      'validation',
    ]);
    expect(DISCOVERY_QUESTION_PACKS.technical_initiative.map((question) => question.id)).toEqual([
      'problem',
      'urgency',
      'driver',
      'systems',
      'mvp',
      'success',
      'risks',
      'reviewer',
    ]);
    expect(DISCOVERY_QUESTION_PACKS.agent_readiness.map((question) => question.id)).toEqual([
      'problem',
      'acceptance',
      'repo',
      'modules',
      'tests',
      'risks',
      'mode',
      'approval',
    ]);
  });

  it('has unique ids and non-empty texts within every pack', () => {
    for (const [inputType, pack] of Object.entries(DISCOVERY_QUESTION_PACKS)) {
      const ids = pack.map((question) => question.id);
      expect(new Set(ids).size, `duplicate ids in ${inputType} pack`).toBe(ids.length);
      for (const question of pack) {
        expect(question.text.trim().length, `${inputType}/${question.id}`).toBeGreaterThan(0);
        expect(question.text.endsWith('?'), `${inputType}/${question.id} ends with ?`).toBe(true);
      }
    }
  });

  it('every pack asks the problem question scoring relies on', () => {
    for (const [inputType, pack] of Object.entries(DISCOVERY_QUESTION_PACKS)) {
      expect(
        pack.some((question) => question.id === 'problem'),
        `${inputType} pack must include a problem question`,
      ).toBe(true);
    }
  });
});
