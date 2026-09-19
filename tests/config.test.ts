import { loadConfig } from '../src/config.js';

describe('configuration', () => {
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
