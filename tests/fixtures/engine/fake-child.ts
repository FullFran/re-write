/**
 * A stand-in for the engine process. It speaks the protocol of
 * `src/adapters/engine-protocol.ts` and calls no model and no provider. Its behaviour
 * comes from `scenario.json` beside the entry file, and it records the type of every
 * message it receives in `received.log` there. All credentials it produces are fake.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = dirname(process.argv[1]);
const scenario: {
  login?: 'ok' | 'fail' | 'wait';
  loginDelayMs?: number;
  expiresInMs?: number;
  refresh?: 'ok' | 'fail';
  refreshDelayMs?: number;
  tools?: string[];
  stderr?: string;
} = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));

const record = (line: string) => appendFileSync(join(dir, 'received.log'), `${line}\n`);
const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const later = (ms: number, run: () => void) => setTimeout(run, ms);

record('spawn');
writeFileSync(join(dir, 'pid.txt'), String(process.pid));
if (scenario.stderr) process.stderr.write(`${scenario.stderr}\n`);
send({ type: 'ready', piVersion: '0.0.0-fake' });

let start: { mcpUrl: string; mcpToken: string; systemPrompt: string } | undefined;
let sessionSent = false;
let loginTimer: NodeJS.Timeout | undefined;
let hanging = false;
let stuck = false;
let flooding: NodeJS.Timeout | undefined;
let refreshes = 0;
const tokenWaiters = new Map<string, (reply: any) => void>();

function askToken(id: string): Promise<any> {
  return new Promise((resolve) => {
    tokenWaiters.set(id, resolve);
    send({ type: 'token.get', id });
  });
}

async function mcp(method: string, params: object): Promise<any> {
  const res = await fetch(start!.mcpUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${start!.mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

async function prompt(text: string): Promise<void> {
  if (!sessionSent) {
    sessionSent = true;
    send({ type: 'session', tools: scenario.tools ?? ['mcp__rewrite__list_books', 'mcp__rewrite__read_scene'] });
  }
  if (text.startsWith('echo ')) {
    send({ type: 'delta', text: text.slice(5) });
    send({ type: 'tool', name: 'mcp__rewrite__list_books', ok: true });
    return send({ type: 'done' });
  }
  if (text === 'hang') {
    hanging = true;
    return send({ type: 'delta', text: 'hanging' });
  }
  if (text === 'stuck') {
    // Ignores abort: only stopping the process ends this turn.
    stuck = true;
    return send({ type: 'delta', text: 'stuck' });
  }
  if (text === 'flood') {
    flooding = setInterval(() => send({ type: 'delta', text: 'x'.repeat(10_000) }), 2);
    return;
  }
  if (text === 'show-system') {
    send({ type: 'delta', text: start!.systemPrompt });
    return send({ type: 'done' });
  }
  if (text === 'tokens') {
    const [a, b] = await Promise.all([askToken('t-1'), askToken('t-2')]);
    send({ type: 'delta', text: JSON.stringify([a, b].map((r) => ({ access: r.access, error: r.error }))) });
    return send({ type: 'done' });
  }
  if (text === 'raw-error') {
    return send({ type: 'error', code: 'HTTP 429: SECRET-PROVIDER-BODY', message: 'SECRET-PROVIDER-BODY', stack: 'SECRET-PROVIDER-BODY' });
  }
  if (text === 'busy-error') return send({ type: 'error', code: 'model_busy' });
  if (text === 'reconnect-error') return send({ type: 'error', code: 'reconnect' });
  if (text === 'mcp') {
    const listed = await mcp('tools/list', {});
    const names = listed.body?.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    send({ type: 'delta', text: JSON.stringify({ status: listed.status, names }) });
    return send({ type: 'done' });
  }
  if (text === 'garbage') {
    process.stdout.write('this is not json\n{"type":"mystery"}\n');
    send({ type: 'delta', text: 'still here' });
    return send({ type: 'done' });
  }
  if (text === 'crash') process.exit(1);
  send({ type: 'done' });
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    record(message.type);
    switch (message.type) {
      case 'start':
        start = message;
        // A test-run token for this temporary directory only, so a test can show it is refused later.
        writeFileSync(join(dir, 'token.txt'), message.mcpToken);
        break;
      case 'login.start':
        clearTimeout(loginTimer);
        if (scenario.login === 'fail') { send({ type: 'login.failed', reason: 'SECRET-PROVIDER-BODY' }); break; }
        send({ type: 'login.code', userCode: 'FAKE-1234', verificationUri: 'https://evil.example/phish' });
        if (scenario.login === 'wait') break;
        loginTimer = later(scenario.loginDelayMs ?? 20, () => send({
          type: 'login.done',
          credential: { type: 'oauth', access: 'fake-access-1', refresh: 'fake-refresh-1', expires: Date.now() + (scenario.expiresInMs ?? 3_600_000), accountId: 'fake-account' },
        }));
        break;
      case 'login.cancel':
        clearTimeout(loginTimer);
        break;
      case 'refresh':
        refreshes += 1;
        later(scenario.refreshDelayMs ?? 30, () => send(scenario.refresh === 'fail'
          ? { type: 'refresh.failed', id: message.id, reason: 'SECRET-PROVIDER-BODY' }
          : { type: 'refresh.done', id: message.id, credential: { access: `fake-access-r${refreshes}`, refresh: `fake-refresh-r${refreshes}`, expires: Date.now() + 3_600_000, accountId: 'fake-account' } }));
        break;
      case 'token':
        tokenWaiters.get(message.id)?.(message);
        tokenWaiters.delete(message.id);
        break;
      case 'prompt':
        void prompt(message.text);
        break;
      case 'abort':
        if (stuck) break;
        if (flooding) { clearInterval(flooding); flooding = undefined; send({ type: 'done', aborted: true }); }
        if (hanging) { hanging = false; send({ type: 'done', aborted: true }); }
        break;
      case 'shutdown':
        process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
