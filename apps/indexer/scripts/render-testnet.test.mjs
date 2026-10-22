import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { renderTestnetConfig } from './render-testnet.mjs';

const env = {
  TESTNET_FACTORY_ADDRESS: '0x1234567890123456789012345678901234567890',
  TESTNET_START_BLOCK: '12345',
  TESTNET_RPC_URL: 'https://rpc.example.invalid/key?token=test',
};
const reply = (result = '0xb626') => async (_url, options) => {
  assert.deepEqual(JSON.parse(options.body), { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  assert.equal(options.method, 'POST');
  assert.ok(options.signal instanceof AbortSignal);
  return Response.json({ jsonrpc: '2.0', id: 1, result });
};

test('renders RPC-only chain 46630 using canonical event declarations without mainnet addresses', async () => {
  const output = await renderTestnetConfig({ env, fetchImpl: reply() });
  const main = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
  const contracts = main.slice(main.indexOf('\ncontracts:'), main.indexOf('\nchains:'));
  assert.ok(output.includes(contracts));
  assert.match(output, /name: dockhood-testnet\n/);
  assert.match(output, /chains:\n  - id: 46630\n    start_block: 12345\n    rpc:\n      url: "https:\/\/rpc.example.invalid\/key\?token=test"\n      for: sync\n/);
  assert.match(output, new RegExp(`address: "${env.TESTNET_FACTORY_ADDRESS}"`));
  assert.equal((output.match(/^contracts:/gm) ?? []).length, 1);
  assert.equal((output.match(/^chains:/gm) ?? []).length, 1);
  assert.doesNotMatch(output, /7eD598|26841846|hypersync_config|id: 4663\n/);
});

test('uses the RPC configuration supported by the installed Envio 3.13 schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../node_modules/envio/evm.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.Chain.properties.rpc.anyOf[0].$ref, '#/$defs/RpcSelection');
  assert.ok(schema.$defs.RpcSelection.anyOf.some((type) => type.$ref === '#/$defs/Rpc'));
  assert.ok(schema.$defs.Rpc.properties.url);
  assert.ok(schema.$defs.For.oneOf.some((type) => type.const === 'sync'));
});

test('requires every input and rejects zero/malformed values before contacting RPC', async () => {
  const bad = {
    TESTNET_FACTORY_ADDRESS: ['', ' ', '0x' + '0'.repeat(40), '0x123', 'not-an-address'],
    TESTNET_START_BLOCK: ['', '0', '-1', '1.5', '1e3', '0x10', 'latest', '9007199254740992', '1\nchains:'],
    TESTNET_RPC_URL: ['', 'not-a-url', 'wss://rpc.example.invalid', 'https://rpc.example.invalid/#x', 'https://${RPC_HOST}'],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of [...values, undefined]) {
      await assert.rejects(renderTestnetConfig({
        env: { ...env, [key]: value },
        fetchImpl: () => { assert.fail('invalid inputs must not contact RPC'); },
      }), new RegExp(key));
    }
  }
});

test('rejects mainnet, other chains and malformed JSON-RPC responses', async () => {
  for (const result of ['0x1237', '0x1', '46630', 46630, null, '0xgarbage']) {
    await assert.rejects(renderTestnetConfig({ env, fetchImpl: reply(result) }), /chain ID 46630|invalid eth_chainId/);
  }
  for (const payload of [null, {}, { jsonrpc: '2.0', id: 2, result: '0xb626' },
    { jsonrpc: '2.0', id: 1, error: { code: -32601 }, result: '0xb626' }]) {
    await assert.rejects(renderTestnetConfig({ env, fetchImpl: async () => Response.json(payload) }), /invalid eth_chainId/);
  }
});

test('reports RPC failures without exposing endpoint credentials', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`secret: ${env.TESTNET_RPC_URL}`); },
    async () => new Response('', { status: 503 }),
    async () => new Response('not JSON'),
  ]) {
    await assert.rejects(renderTestnetConfig({ env, fetchImpl }), (error) => {
      assert.match(error.message, /TESTNET_RPC_URL/);
      assert.ok(!error.message.includes(env.TESTNET_RPC_URL));
      return true;
    });
  }
});

test('CLI only writes after validation and leaves an existing config untouched on failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dockhood-testnet-render-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(new URL('./render-testnet.mjs', import.meta.url), join(directory, 'scripts/render-testnet.mjs'));
  copyFileSync(new URL('../config.yaml', import.meta.url), join(directory, 'config.yaml'));
  let chainId = '0x1237';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).method, 'eth_chainId');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: chainId }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  const run = (overrides = {}) => promisify(execFile)(process.execPath, [join(directory, 'scripts/render-testnet.mjs')], {
    env: { ...process.env, ...env, TESTNET_RPC_URL: rpc, ...overrides },
  });
  const output = join(directory, 'config.testnet.local.yaml');
  await assert.rejects(run(), /chain ID 46630/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.tmp`), false);
  chainId = '0xb626';
  await run();
  const good = readFileSync(output, 'utf8');
  assert.match(good, /id: 46630/);
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o777, 0o600);
  await assert.rejects(run({ TESTNET_FACTORY_ADDRESS: '' }), /TESTNET_FACTORY_ADDRESS is required/);
  assert.equal(readFileSync(output, 'utf8'), good);
  assert.equal(existsSync(`${output}.tmp`), false);
});
