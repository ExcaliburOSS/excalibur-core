/**
 * @excalibur/enterprise-sync — optional sync client connecting local
 * Excalibur Core usage to Excalibur Enterprise (Build Contract §4.8,
 * OSS spec §13).
 *
 * @experimental The whole package is experimental in M1: the Enterprise
 * control plane is not public yet. Without `excalibur login` everything stays
 * local; sync is optional and transparent by design.
 *
 * @packageDocumentation
 */
export { enterpriseConfigSchema } from './types';
export type { EnterpriseConfig, EnterpriseSyncClient } from './types';

export { HttpEnterpriseSyncClient, SYNC_FAILED_CODE } from './http-client';
export type { HttpEnterpriseSyncClientOptions } from './http-client';

export {
  CREDENTIALS_DIR_MODE,
  CREDENTIALS_FILE_MODE,
  CREDENTIALS_RELATIVE_PATH,
  EXCALIBUR_API_KEY_ENV,
  EXCALIBUR_BASE_URL_ENV,
  cliCredentialsSchema,
  getCredentialsFilePath,
  loadCliCredentials,
  saveCliCredentials,
} from './credentials';
export type { CliCredentials, CredentialsOptions } from './credentials';

export { MAX_BODY_EXCERPT_LENGTH, buildBodyExcerpt, redactSyncSecrets } from './redact';
