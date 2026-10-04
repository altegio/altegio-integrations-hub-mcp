import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  test('loads the HTTP capacity override and its measured default', () => {
    expect(loadConfig({ ALTEGIO_PARTNER_TOKEN: 'partner-token' }).MCP_HTTP_MAX_SESSIONS).toBe(384);
    expect(
      loadConfig({ ALTEGIO_PARTNER_TOKEN: 'partner-token', MCP_HTTP_MAX_SESSIONS: '256' })
        .MCP_HTTP_MAX_SESSIONS
    ).toBe(256);
  });

  test.each(['', '0', '-1', '1.5', 'invalid', 'Infinity'])(
    'rejects invalid HTTP capacity %s at boot',
    (value) => {
      expect(() =>
        loadConfig({ ALTEGIO_PARTNER_TOKEN: 'partner-token', MCP_HTTP_MAX_SESSIONS: value })
      ).toThrow();
    }
  );

  test('uses the Integrations Hub state directory name', () => {
    const config = loadConfig({
      ALTEGIO_PARTNER_TOKEN: 'partner-token',
      INTEGRATIONS_HUB_MCP_STATE_DIR: '/tmp/integrations-hub-state',
    });

    expect(config.INTEGRATIONS_HUB_MCP_STATE_DIR).toBe('/tmp/integrations-hub-state');
  });

  test('accepts the former state directory variable during migration', () => {
    const config = loadConfig({
      ALTEGIO_PARTNER_TOKEN: 'partner-token',
      MARKETPLACE_MCP_STATE_DIR: '/tmp/marketplace-state',
    });

    expect(config.INTEGRATIONS_HUB_MCP_STATE_DIR).toBe('/tmp/marketplace-state');
  });
});
