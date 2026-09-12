import { redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  test('recursively removes credentials without hiding validation booleans', () => {
    expect(
      redactSecrets({
        partner_system: { token: 'partner-secret' },
        applications: [{ application_token: 'user-secret', id: 7 }],
        token_valid: true,
      })
    ).toEqual({
      partner_system: { token: '[REDACTED]' },
      applications: [{ application_token: '[REDACTED]', id: 7 }],
      token_valid: true,
    });
  });
});
