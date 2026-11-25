import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvironment } from '../../src/config/env.mjs';

const validEnvironment = {
  DASHBOARD_API_KEY: 'a'.repeat(32),
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  TOKEN_ENCRYPTION_KEY: 'b'.repeat(64)
};

test('DNS server overrides are trimmed and empty entries are removed', () => {
  const config = loadEnvironment({
    ...validEnvironment,
    DNS_SERVERS: ' 1.1.1.1, ,8.8.8.8 '
  });

  assert.deepEqual(config.dnsServers, ['1.1.1.1', '8.8.8.8']);
  assert.ok(Object.isFrozen(config.dnsServers));
});
