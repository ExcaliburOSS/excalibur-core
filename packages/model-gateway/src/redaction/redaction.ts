/**
 * Secret redaction.
 *
 * The implementation now lives in `@excalibur/shared` so EVERY package applies
 * identical redaction at the point data is captured (skill/instruction scans,
 * session history, enterprise sync), not just at the model boundary. This
 * module re-exports it so existing `@excalibur/model-gateway` imports keep
 * working.
 */
export { redactSecrets } from '@excalibur/shared';
