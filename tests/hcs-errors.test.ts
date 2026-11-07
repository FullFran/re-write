import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HCS_ERROR_CODES, HcsFailure, hcsError, isHcsErrorCode } from '../src/hcs/errors.ts';

test('HCS-0006-R002 error codes form a closed set', () => {
  assert.equal(HCS_ERROR_CODES.length, 16);
  assert.equal(isHcsErrorCode('integrity_mismatch'), true);
  assert.equal(isHcsErrorCode('quote_not_literal'), false);
  assert.throws(() => hcsError('not_a_code' as never, 'x'), TypeError);
});

test('hcsError builds error objects and keeps details under extension names', () => {
  assert.deepEqual(hcsError('duplicate_entry', 'Entry repeated', { entry: 'com.example.a', requirement: 'HCS-0001-R003' }), {
    code: 'duplicate_entry', message: 'Entry repeated', entry: 'com.example.a', requirement: 'HCS-0001-R003',
  });
  assert.deepEqual(hcsError('timeout', 'Slow', { details: { 'x-rewrite-phase': 'prepare' } }).details, { 'x-rewrite-phase': 'prepare' });
  assert.throws(() => hcsError('timeout', 'Slow', { details: { phase: 'prepare' } }), TypeError);
  assert.throws(() => hcsError('timeout', 'Slow', { requirement: 'R003' }), TypeError);
  assert.throws(() => hcsError('timeout', ''), TypeError);
  assert.throws(() => hcsError('timeout', 'x', { entry: 'invalid' }), TypeError);
  assert.throws(() => hcsError('timeout', 'x', { capability: 'com.example.cap' }), TypeError);
  assert.equal(hcsError('timeout', 'x', { capability: 'com.example.cap@1' }).capability, 'com.example.cap@1');
  const details = { 'x-phase': 'before' };
  const error = hcsError('timeout', 'x', { details });
  details['x-phase'] = 'after';
  assert.equal(error.details?.['x-phase'], 'before');
});

test('HcsFailure carries every error', () => {
  assert.throws(() => new HcsFailure([]), TypeError);
  const failure = new HcsFailure([hcsError('duplicate_entry', 'a'), hcsError('duplicate_entry', 'b')]);
  assert.equal(failure.errors.length, 2);
  assert.match(failure.message, /duplicate_entry: a; duplicate_entry: b/);
});
