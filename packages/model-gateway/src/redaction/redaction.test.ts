import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redaction';

/**
 * The exhaustive pattern coverage lives in `@excalibur/shared`'s
 * redaction.test.ts (that is where the implementation lives). Here we only
 * assert that the model-gateway re-export is wired up and functional, so a
 * consumer importing `redactSecrets` from `@excalibur/model-gateway` keeps
 * getting real redaction.
 */
describe('redactSecrets (re-exported from @excalibur/shared)', () => {
  it('redacts a representative secret through the re-export', () => {
    const redacted = redactSecrets('OPENAI_API_KEY=sk-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('sk-Ab12');
    expect(redacted).toContain('OPENAI_API_KEY=');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('just a normal sentence')).toBe('just a normal sentence');
  });
});
