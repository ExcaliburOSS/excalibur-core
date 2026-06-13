/**
 * @excalibur/declarative-schemas — zod schemas for the 10 declarative
 * extension types (extensions spec §4), the discriminated union over them,
 * and the YAML/Markdown parsers used by the extension runtime.
 *
 * `workflow` and `methodology` remain owned by `@excalibur/workflow-schema`;
 * their schemas and types are re-exported here so consumers of this package
 * see the full declarative surface.
 */
export * from './types';
export * from './schemas';
export * from './union';
export * from './parse';
export * from './markdown';

export {
  methodologySchema,
  workflowDefinitionSchema,
  workflowPhaseSchema,
  type Methodology,
  type WorkflowDefinition,
  type WorkflowPhase,
} from '@excalibur/workflow-schema';
