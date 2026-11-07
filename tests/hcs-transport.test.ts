import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HCS_ERROR_CODES, hcsError } from '../src/hcs/errors.ts';
import { HCS_ERROR_STATUS, toJsonRpcError, toProblemDetails, validateHcsError } from '../src/hcs/transport.ts';

test('HCS-0006 transports preserve all codes and schema-valid errors', () => {
  const statuses = [422, 422, 422, 422, 422, 422, 409, 422, 409, 409, 403, 404, 504, 502, 422, 409];
  HCS_ERROR_CODES.forEach((code, index) => {
    const error = hcsError(code, 'Failure', { entry: 'com.example.entry', capability: 'com.example.cap@1', requirement: 'HCS-0001-R001', details: { 'x-example': 1 } });
    const rpc = toJsonRpcError(error, 7);
    assert.deepEqual(rpc, { jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Failure', data: { hcsError: error } } });
    const problem = toProblemDetails(error, '/instance');
    assert.deepEqual(problem, { type: `urn:hcs:error:${code}`, title: code, status: statuses[index], detail: 'Failure', instance: '/instance', hcsError: error });
    assert.equal(HCS_ERROR_STATUS[code], statuses[index]);
    assert.deepEqual(validateHcsError(rpc.error.data.hcsError), []);
    assert.deepEqual(validateHcsError(problem.hcsError), []);
    assert.equal('instance' in toProblemDetails(error), false);
  });
  assert.equal(toJsonRpcError(hcsError('timeout', 'x'), null).id, null);
  assert.equal(toJsonRpcError(hcsError('timeout', 'x'), 'id').id, 'id');
});

test('HCS error validation rejects malformed objects and members', () => {
  for (const value of [null, [], 'x', {}, { code: 'bad', message: 'x' }, { code: 'timeout', message: '' }, { code: 'timeout', message: 1 }, { code: 'timeout', message: 'x', entry: 'bad' }, { code: 'timeout', message: 'x', capability: 'bad' }, { code: 'timeout', message: 'x', requirement: 'bad' }, { code: 'timeout', message: 'x', details: [] }, { code: 'timeout', message: 'x', details: { bad: 1 } }, { code: 'timeout', message: 'x', extra: 1 }]) {
    assert.notEqual(validateHcsError(value).length, 0, JSON.stringify(value));
  }
  assert.deepEqual(validateHcsError({ code: 'timeout', message: 'x' }), []);
});
