import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCapabilityRef, isDottedId, isExtensionName, capabilitySatisfies, isRewriteOwned, REWRITE_CAPABILITIES, REWRITE_PERMISSIONS, REVIEW_DECIDE } from '../src/hcs/ids.ts';

test('HCS-0002-R001 parses only capability references with valid majors', () => {
  assert.deepEqual(parseCapabilityRef('com.example.read@0'), { ok: true, id: 'com.example.read', major: 0 });
  assert.deepEqual(parseCapabilityRef('com.example.read@999999999'), { ok: true, id: 'com.example.read', major: 999999999 });
  for (const value of ['com.example.read', 'com.example.read@01', 'Com.example@1', 'single@1', 'com.example@1000000000', 'com.-bad@1', 'com.example@1\n']) {
    const result = parseCapabilityRef(value);
    assert.equal(result.ok, false, value);
    if (!result.ok) assert.equal(typeof result.reason, 'string');
  }
  assert.equal(isDottedId('com.example.read'), true);
  for (const value of ['single', 'com.Example', 'com.-bad', 'com.bad-', 'com.example\n']) assert.equal(isDottedId(value), false, value);
  assert.equal(isExtensionName('x-rewrite-example'), true);
  for (const value of ['x_bad', 'x-Bad', 'x-bad_', 'x-bad\n']) assert.equal(isExtensionName(value), false, value);
});

test('HCS-0002-R002 and R003 match exact valid references', () => {
  assert.equal(capabilitySatisfies('com.example.read@1', 'com.example.read@1'), true);
  for (const provided of ['com.example.read@2', 'com.example.other@1', 'com.example.read', 'com.example.read@01']) assert.equal(capabilitySatisfies('com.example.read@1', provided), false);
  assert.equal(capabilitySatisfies('invalid', 'invalid'), false);
});

test('rewrite capability and permission registry is owned and covers MCP registrations exactly once', () => {
  for (const row of REWRITE_CAPABILITIES) {
    const parsed = parseCapabilityRef(row.ref);
    assert.equal(parsed.ok, true, row.ref);
    if (parsed.ok) { assert.equal(parsed.major, row.major); assert.equal(isRewriteOwned(parsed.id), true); }
    assert.ok(row.contract);
    assert.ok(['host', 'package'].includes(row.provider));
  }
  assert.equal(isRewriteOwned('com.fullfran.rewriteevil.foo'), false);
  assert.equal(isRewriteOwned('com.fullfran.rewrite.foo'), true);
  for (const permission of REWRITE_PERMISSIONS) { assert.equal(isDottedId(permission), true); assert.equal(isRewriteOwned(permission), true); }
  assert.equal(REWRITE_PERMISSIONS.includes(REVIEW_DECIDE as never), false);
  const source = readFileSync(new URL('../src/adapters/mcp.ts', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/server\.registerTool\('([^']+)'/g)].map(match => match[1]);
  assert.ok(registered.length > 0);
  const listed = REWRITE_CAPABILITIES.flatMap(row => [...row.mcpTools]);
  assert.deepEqual([...listed].sort(), [...registered].sort());
  assert.equal(new Set(listed).size, listed.length);
});
