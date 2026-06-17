/**
 * The Verification Mesh orchestrator now lives in `@excalibur/core` (so both this
 * CLI command and the run-lifecycle gate share it). Re-exported here for the
 * existing `verify` command + tests.
 */
export { runVerificationMesh, type RunMeshInput } from '@excalibur/core';
