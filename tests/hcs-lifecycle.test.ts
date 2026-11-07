import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_STATES, ALLOWED_TRANSITIONS, canTransition, validateEntryStatus } from '../src/hcs/lifecycle.ts';

const states = ['discovered', 'validated', 'resolved', 'authorized', 'prepared', 'active', 'draining', 'stopped', 'failed'];
const edges: Record<string, string[]> = {
  discovered: ['validated', 'failed'], validated: ['resolved', 'failed'], resolved: ['authorized', 'failed'],
  authorized: ['prepared', 'failed'], prepared: ['active', 'failed'], active: ['draining', 'failed'],
  draining: ['stopped', 'failed'], stopped: [], failed: [],
};
const status = { entry: 'example.package', version: '1.0', state: 'active' };
const error = { code: 'timeout', message: 'Timed out' };

test('state diagram accepts exactly its edges', () => {
  assert.deepEqual(ENTRY_STATES, states);
  assert.deepEqual(ALLOWED_TRANSITIONS, edges);
  for (const from of states) for (const to of states) assert.equal(canTransition(from, to), edges[from].includes(to), `${from} -> ${to}`);
  assert.equal(canTransition('unknown', 'failed'), false);
  assert.equal(canTransition('active', 'unknown'), false);
});

test('valid statuses and extensions', () => {
  for (const state of states) assert.deepEqual(validateEntryStatus({ ...status, state, ...(state === 'failed' ? { error } : {}), 'x-test-value': null }), []);
  assert.deepEqual(validateEntryStatus({ ...status, version: '😀'.repeat(128) }), []);
  assert.deepEqual(validateEntryStatus({ ...status, state: 'failed', error: { ...error, entry: 'example.package', capability: 'example.cap@1', requirement: 'HCS-0004-R007', details: { 'x-test': 1 } } }), []);
});

test('invalid statuses report violations', () => {
  const invalid: unknown[] = [null, [], {}, { ...status, entry: 'bad' }, { ...status, entry: 'a'.repeat(129) + '.b' },
    { ...status, version: '' }, { ...status, version: 'a b' }, { ...status, version: 'a'.repeat(129) },
    { ...status, state: 'unknown' }, { ...status, state: 'failed' }, { ...status, error },
    { ...status, extra: 1 }, { ...status, 'x-Bad': 1 },
    ...[null, {}, { code: 'bogus', message: 'a' }, { code: 'timeout', message: '' },
      { ...error, entry: 'bad' }, { ...error, capability: 'bad' }, { ...error, requirement: 'bad' },
      { ...error, details: [] }, { ...error, details: { bad: 1 } }, { ...error, 'x-extra': 1 }]
      .map(error => ({ ...status, state: 'failed', error }))];
  for (const value of invalid) assert.ok(validateEntryStatus(value).length > 0, JSON.stringify(value));
});
