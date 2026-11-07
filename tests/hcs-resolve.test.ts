import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolve } from '../src/hcs/resolve.ts';
import { REWRITE_HOST } from '../src/hcs/host.ts';
import { parseCapabilityRef, isRewriteOwned, isDottedId, isExtensionName } from '../src/hcs/ids.ts';
import pkg from '../package.json' with { type: 'json' };


const host = { id: 'dev.example.host', version: '1', platform: { os: 'linux', architecture: 'amd64' }, contributionKinds: ['skill'], mediaTypes: ['application/test'], builtins: [], activationPolicy: 'partial' as const };
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: '1', contentHash: `sha256:${'0'.repeat(64)}`, size: 0, mediaType: 'application/test', contributions: [{ kind: 'skill', path: 'data' }], ...extra });
const catalog = (...entries: ReturnType<typeof entry>[]) => ({ hcsVersion: '0.1', id: 'dev.example.catalog', version: '1', entries });
const codes = (result: ReturnType<typeof resolve>) => result.errors.map(({code, entry, capability}) => ({code, entry, ...(capability === undefined ? {} : {capability})}));

test('host declaration is consistent and builtins belong to rewrite', () => {
  assert.equal(REWRITE_HOST.version, pkg.version); assert.equal(REWRITE_HOST.activationPolicy, 'all-or-nothing');
  assert.ok(REWRITE_HOST.platform.os && REWRITE_HOST.platform.architecture);
  assert.equal(new Set(REWRITE_HOST.contributionKinds).size, REWRITE_HOST.contributionKinds.length);
  assert.ok(REWRITE_HOST.builtins.length > 0);
  for (const ref of REWRITE_HOST.builtins) { const parsed = parseCapabilityRef(ref); assert.ok(parsed.ok); assert.ok(isRewriteOwned(parsed.id)); }
});
function assertHostShape(value: unknown): void {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const h = value as Record<string, unknown>;
  const keys = (obj: Record<string, unknown>, allowed: string[]) => {
    for (const key of Object.keys(obj)) assert.ok(allowed.includes(key) || isExtensionName(key), `Unexpected member: ${key}`);
  };
  keys(h, ['id', 'version', 'platform', 'contributionKinds', 'mediaTypes', 'builtins', 'activationPolicy']);
  assert.equal('id' in h, 'version' in h);
  if ('id' in h) {
    assert.ok(typeof h.id === 'string' && h.id.length <= 128 && isDottedId(h.id));
    assert.ok(typeof h.version === 'string' && [...h.version].length > 0 && [...h.version].length <= 128 && !/\s/u.test(h.version));
  }
  assert.ok(h.platform !== null && typeof h.platform === 'object' && !Array.isArray(h.platform));
  const platform = h.platform as Record<string, unknown>;
  keys(platform, ['os', 'architecture', 'variant']);
  for (const key of ['os', 'architecture']) assert.ok(typeof platform[key] === 'string' && platform[key].length > 0);
  if ('variant' in platform) assert.ok(typeof platform.variant === 'string' && platform.variant.length > 0);
  const list = (value: unknown, valid: (item: unknown) => boolean) => {
    assert.ok(Array.isArray(value));
    assert.equal(new Set(value).size, value.length);
    for (const item of value) assert.ok(valid(item));
  };
  list(h.contributionKinds, x => typeof x === 'string' && (x === 'skill' || x === 'mcp-server' || isExtensionName(x)));
  list(h.mediaTypes, x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(x) && !x.endsWith('\n'));
  list(h.builtins, x => typeof x === 'string' && x.length <= 140 && parseCapabilityRef(x).ok);
  if ('activationPolicy' in h) assert.ok(h.activationPolicy === 'all-or-nothing' || h.activationPolicy === 'partial');
}
test('rewrite host matches the complete host shape', () => {
  assertHostShape(REWRITE_HOST);
  const { id, version, ...anonymous } = REWRITE_HOST;
  assertHostShape(anonymous);
  assertHostShape({ ...REWRITE_HOST, 'x-test': true, platform: { ...REWRITE_HOST.platform, 'x-test': true } });
  for (const invalid of [
    { ...REWRITE_HOST, id: 'Invalid Host' }, { ...anonymous, id }, { ...anonymous, version },
    { ...REWRITE_HOST, version: 'bad version' }, { ...REWRITE_HOST, unexpected: true },
    { ...REWRITE_HOST, platform: { os: 'linux' } }, { ...REWRITE_HOST, platform: { os: '', architecture: 'amd64' } },
    { ...REWRITE_HOST, platform: { os: 'linux', architecture: 'amd64', variant: '' } },
    { ...REWRITE_HOST, platform: { os: 'linux', architecture: 'amd64', extra: true } },
    { ...REWRITE_HOST, contributionKinds: ['unknown'] }, { ...REWRITE_HOST, contributionKinds: ['skill', 'skill'] },
    { ...REWRITE_HOST, mediaTypes: ['invalid'] }, { ...REWRITE_HOST, mediaTypes: ['application/test', 'application/test'] },
    { ...REWRITE_HOST, builtins: ['bad'] }, { ...REWRITE_HOST, builtins: ['dev.example.cap@1', 'dev.example.cap@1'] },
    { ...REWRITE_HOST, activationPolicy: 'other' }, { ...REWRITE_HOST, builtins: undefined },
  ]) assert.throws(() => assertHostShape(invalid));
});
test('eligibility checks media, kind, platform and host in order', () => {
  const result = resolve(catalog(entry('dev.example.a', { mediaType: 'application/other' }), entry('dev.example.b', { contributions: [{kind:'x-other',path:'x'}] }), entry('dev.example.c', { compatibility: { platforms: [{os:'other',architecture:'amd64'}] } }), entry('dev.example.d', {compatibility:{hosts:[{id:'dev.other.host',versions:['1']}]}})), host);
  assert.deepEqual(codes(result), [{code:'unsupported_contribution',entry:'dev.example.a'}, {code:'unsupported_contribution',entry:'dev.example.b'}, {code:'platform_incompatible',entry:'dev.example.c'}, {code:'version_incompatible',entry:'dev.example.d'}]); assert.deepEqual(result.errors.map(e => e.requirement), ['HCS-0001-R013','HCS-0001-R008','HCS-0001-R009','HCS-0001-R016']); assert.deepEqual(result.activationOrder, []); assert.deepEqual(result.selected, []);
});
test('dependencies distinguish missing, wrong major and ambiguity', () => {
  const provide = (ref: string) => [{kind:'skill',path:'x',provides:[ref]}];
  const result = resolve(catalog(entry('dev.example.a',{requires:['dev.cap.absent@1']}), entry('dev.example.b',{requires:['dev.cap.old@1']}), entry('dev.example.c',{requires:['dev.cap.multi@1']}), entry('dev.example.d',{contributions:provide('dev.cap.old@2')}), entry('dev.example.e',{contributions:provide('dev.cap.multi@1')}), entry('dev.example.f',{contributions:provide('dev.cap.multi@1')})), host);
  assert.deepEqual(codes(result), [{code:'missing_dependency',entry:'dev.example.a',capability:'dev.cap.absent@1'}, {code:'version_incompatible',entry:'dev.example.b',capability:'dev.cap.old@1'}, {code:'ambiguous_provider',entry:'dev.example.c',capability:'dev.cap.multi@1'}]); assert.deepEqual(result.errors.map(e => e.requirement), ['HCS-0003-R002','HCS-0003-R003','HCS-0003-R004']); assert.deepEqual(result.activationOrder,['dev.example.d','dev.example.e','dev.example.f']); assert.deepEqual(result.selected,result.activationOrder);
});
test('cycles and failed providers propagate; policy controls selection', () => {
  const provide = (ref: string) => [{kind:'skill',path:'x',provides:[ref]}];
  const c = catalog(entry('dev.example.a',{requires:['dev.cap.b@1'],contributions:provide('dev.cap.a@1')}), entry('dev.example.b',{requires:['dev.cap.a@1'],contributions:provide('dev.cap.b@1')}), entry('dev.example.c',{requires:['dev.cap.a@1']}), entry('dev.example.d'));
  const result = resolve(c,{...host,activationPolicy:'all-or-nothing'}); assert.deepEqual(codes(result),[{code:'dependency_cycle',entry:'dev.example.a'},{code:'dependency_cycle',entry:'dev.example.b'},{code:'missing_dependency',entry:'dev.example.c',capability:'dev.cap.a@1'}]); assert.deepEqual(result.errors.map(e => e.requirement), ['HCS-0003-R006','HCS-0003-R006','HCS-0003-R005']); assert.deepEqual(result.activationOrder,['dev.example.d']); assert.deepEqual(result.selected,[]);
});
test('propagation cites R005 but an initially ineligible provider cites R002', () => {
  const provide = (ref: string) => [{kind:'skill',path:'x',provides:[ref]}];
  const result = resolve(catalog(entry('dev.example.a',{requires:['dev.cap.missing@1'],contributions:provide('dev.cap.a@1')}), entry('dev.example.b',{requires:['dev.cap.a@1'],contributions:provide('dev.cap.b@1')}), entry('dev.example.c',{requires:['dev.cap.b@1']}), entry('dev.example.d',{mediaType:'application/other',contributions:provide('dev.cap.d@1')}), entry('dev.example.e',{requires:['dev.cap.d@1']})), host);
  assert.deepEqual(result.errors.map(({code, entry, capability, requirement}) => ({code,entry,capability,requirement})), [
    {code:'unsupported_contribution',entry:'dev.example.d',capability:undefined,requirement:'HCS-0001-R013'},
    {code:'missing_dependency',entry:'dev.example.a',capability:'dev.cap.missing@1',requirement:'HCS-0003-R002'},
    {code:'missing_dependency',entry:'dev.example.e',capability:'dev.cap.d@1',requirement:'HCS-0003-R002'},
    {code:'missing_dependency',entry:'dev.example.b',capability:'dev.cap.a@1',requirement:'HCS-0003-R005'},
    {code:'missing_dependency',entry:'dev.example.c',capability:'dev.cap.b@1',requirement:'HCS-0003-R005'},
  ]);
  assert.deepEqual(result.activationOrder, []); assert.deepEqual(result.selected, []);
});
test('builtins satisfy requirements and order uses byte comparison', () => {
  const result = resolve(catalog(entry('dev.example.a1',{requires:['dev.cap.core@1']}),entry('dev.example.a-1')), {...host,builtins:['dev.cap.core@1']});
  assert.deepEqual(result.errors,[]); assert.deepEqual(result.activationOrder,['dev.example.a-1','dev.example.a1']); assert.deepEqual(result.selected,result.activationOrder);
});
