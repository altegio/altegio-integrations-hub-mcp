import type { Config } from '../src/config.js';
import { MarketplaceClient, type RequestOptions } from '../src/client.js';

export const testConfig: Config = {
  ALTEGIO_PARTNER_TOKEN: 'partner-test-token',
  ALTEGIO_API_BASE: 'https://api.example.test/api/v1',
  ALTEGIO_APP_BASE: 'https://app.example.test',
  PORT: 8094,
  ALLOW_BACKOFFICE: false,
  INTEGRATIONS_HUB_MCP_STATE_DIR: '/tmp/altegio-integrations-hub-mcp-test-state',
};

export class FakeClient extends MarketplaceClient {
  calls: Array<{ path: string; options: RequestOptions }> = [];
  applications: Array<Record<string, unknown>> = [{ id: 7, slug: 'ExistingApp' }];
  responses = new Map<string, unknown>();

  constructor() {
    super({ ...testConfig, ALTEGIO_USER_TOKEN: 'user-test-token' });
  }

  override async request(path: string, options: RequestOptions): Promise<unknown> {
    this.calls.push({ path, options });
    return this.responses.get(path) ?? { success: true, data: {} };
  }

  override async ownedApplications(partnerId: number): Promise<Array<Record<string, unknown>>> {
    void partnerId;
    return this.applications;
  }

  override async assertOwnsApplication(_partnerId: number, applicationId: number): Promise<void> {
    if (!this.applications.some((application) => Number(application.id) === applicationId)) {
      throw new Error('not owned');
    }
  }

  override async partnerTokenForAccount(_partnerId: number): Promise<string> {
    void _partnerId;
    return 'owned-partner-token';
  }
}
