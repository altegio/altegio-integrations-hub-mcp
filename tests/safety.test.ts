import { requireConfirmation } from '../src/safety.js';

describe('safety boundaries', () => {
  test('exact confirmation is required', () => {
    expect(() => requireConfirmation('almost', 'DELETE 42')).toThrow('DELETE 42');
    expect(() => requireConfirmation('DELETE 42', 'DELETE 42')).not.toThrow();
  });
});
