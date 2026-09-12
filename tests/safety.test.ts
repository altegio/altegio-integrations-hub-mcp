import { requireBackoffice, requireConfirmation } from '../src/safety.js';

describe('safety boundaries', () => {
  test('exact confirmation is required', () => {
    expect(() => requireConfirmation('almost', 'DELETE 42')).toThrow('DELETE 42');
    expect(() => requireConfirmation('DELETE 42', 'DELETE 42')).not.toThrow();
  });

  test('backoffice needs both gate and token', () => {
    expect(() => requireBackoffice(false, 'token')).toThrow('disabled');
    expect(() => requireBackoffice(true, undefined)).toThrow('ALTEGIO_ADMIN_USER_TOKEN');
    expect(requireBackoffice(true, 'admin')).toBe('admin');
  });
});
