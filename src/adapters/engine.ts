import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CredentialVault, EngineTokens } from './engine-auth.ts';
import {
  DEVICE_VERIFICATION_URI, encode, LineDecoder, MCP_TOOL_PREFIX, parseChildMessage,
  type ChildMessage, type EngineErrorCode, type ParentMessage, type StoredCredential,
} from './engine-protocol.ts';

export interface EngineSettings {
  /** Key for credentials at rest (AES-256-GCM). */
  key: Buffer;
  dataDir: string;
  /** The engine program, run with this Node. Nothing of it is loaded into the server. */
  entry: string;
  /** Where an engine process reaches this server's MCP endpoint, on loopback. */
  mcpUrl: string;
  maxProcesses: number;
  idleMs: number;
  /** A process, and with it its MCP token, lives at most this long. */
  maxAgeMs?: number;
  /** A credential this close to expiry is refreshed before it is handed out. */
  refreshMarginMs?: number;
  /** How long the server waits for the process to answer a login start or a refresh. */
  replyTimeoutMs?: number;
  /** A pending device login is dropped, and its process stopped, after this long. */
  loginTtlMs?: number;
  /** Login starts allowed per person within `loginWindowMs`. */
  loginLimit?: number;
  loginWindowMs?: number;
  /** Wall-clock limit of one turn. */
  turnTimeoutMs?: number;
  /** Most answer text one turn may stream, in bytes. */
  turnMaxBytes?: number;
  /** How long an aborted turn has to settle before its process is stopped. */
  abortGraceMs?: number;
  /** How long a stopping process is kept so a refresh already sent can come back. */
  refreshGraceMs?: number;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode) {
    super(code);
    this.code = code;
  }
}

export const ENGINE_HTTP_STATUS: Record<EngineErrorCode, number> = {
  busy: 429,
  rate_limited: 429,
  turn_in_progress: 409,
  not_connected: 409,
  reconnect: 409,
  engine_unavailable: 503,
  model_busy: 503,
  provider_error: 502,
  login_failed: 502,
  turn_limit: 504,
};

export type EngineStatus =
  | { state: 'disconnected' | 'connected' | 'reconnect' }
  | { state: 'pending'; user_code?: string; verification_uri: string };

export interface TurnSink {
  event(name: 'delta' | 'tool' | 'done' | 'error', data: object): void;
}

const KILL_GRACE_MS = 2_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // Every waiter handles the rejection itself; this keeps a late one from being unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface Login {
  userCode?: string;
  code: Deferred<string>;
  expiry: NodeJS.Timeout;
}

interface Turn {
  sink: TurnSink;
  end: () => void;
  bytes: number;
  /** Set when the turn passed its time or size limit: whatever comes next, it ends as `turn_limit`. */
  limited: boolean;
  timeout: NodeJS.Timeout;
  abortTimer?: NodeJS.Timeout;
}

interface Proc {
  child: ChildProcess;
  decoder: LineDecoder;
  startedAt: number;
  token?: string;
  toolsChecked: boolean;
  idle?: NodeJS.Timeout;
  turn?: Turn;
  refreshes: Map<string, Deferred<StoredCredential>>;
  /** Detached from its person: it takes no new work. It may still deliver a refresh. */
  stopped: boolean;
  /** The person disconnected: a refresh that comes back is thrown away. */
  discard: boolean;
  exited: boolean;
}

interface Person {
  subject: string;
  proc?: Proc;
  login?: Login;
  reconnect: boolean;
  refreshing?: Promise<StoredCredential>;
  /** When this person started logins, within the rate-limit window. */
  loginStarts: number[];
}

const managers = new Set<EngineManager>();
let hooked = false;

/**
 * Engine processes must not outlive the server. They exit on their own when their stdin
 * closes, which covers a server that dies. A server that got SIGTERM or SIGINT is still
 * alive while `server.close` waits for open connections (a streamed answer is one), so
 * the signal stops them here. The hooks are installed with the first manager: with the
 * engine off, the process handles signals exactly as before.
 */
function hookProcess(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', () => managers.forEach((manager) => manager.killAll()));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      managers.forEach((manager) => { void manager.close(); });
      // Nobody else handles the signal: end as the default action would have.
      if (process.listenerCount(signal) === 1) {
        managers.forEach((manager) => manager.killAll());
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      }
    });
  }
}

/**
 * Starts, feeds and stops the engine processes: at most one per person, started on
 * first use and stopped when idle. It owns the stored credentials and is the only
 * place that refreshes one, so a rotating refresh token is never used twice.
 */
export class EngineManager {
  readonly tokens = new EngineTokens();
  private readonly settings: Required<EngineSettings>;
  private readonly vault: CredentialVault;
  private readonly people = new Map<string, Person>();
  /** Every process not yet torn down, attached to a person or finishing a refresh. */
  private readonly alive = new Set<Proc>();
  private closed = false;

  constructor(settings: EngineSettings) {
    this.settings = {
      maxAgeMs: 60 * 60_000, refreshMarginMs: 10 * 60_000, replyTimeoutMs: 60_000,
      loginTtlMs: 15 * 60_000, loginLimit: 3, loginWindowMs: 15 * 60_000,
      turnTimeoutMs: 10 * 60_000, turnMaxBytes: 2 * 1024 * 1024, abortGraceMs: 5_000, refreshGraceMs: 10_000,
      ...settings,
    };
    this.vault = new CredentialVault(settings.dataDir, settings.key);
    managers.add(this);
    hookProcess();
  }

  /** Processes that hold a slot. */
  liveCount(): number {
    let count = 0;
    for (const person of this.people.values()) if (person.proc) count += 1;
    return count;
  }

  /** People the manager currently keeps anything about. */
  trackedCount(): number {
    this.sweep();
    return this.people.size;
  }

  status(subject: string): EngineStatus {
    const person = this.people.get(subject);
    if (person?.login) {
      return { state: 'pending', ...(person.login.userCode ? { user_code: person.login.userCode } : {}), verification_uri: DEVICE_VERIFICATION_URI };
    }
    try {
      if (!this.vault.read(subject)) return { state: 'disconnected' };
    } catch {
      return { state: 'reconnect' };
    }
    return { state: person?.reconnect ? 'reconnect' : 'connected' };
  }

  /**
   * Starts a device-code login. One at a time per person: a new one cancels the previous.
   * A login holds a process without a credential, so starts are rate-limited per person
   * and the login has a hard deadline.
   */
  async startLogin(subject: string): Promise<{ user_code: string; verification_uri: string; expires_in: number }> {
    this.sweep();
    const person = this.personOf(subject);
    if (person.loginStarts.length >= this.settings.loginLimit) throw new EngineError('rate_limited');
    person.loginStarts.push(Date.now());
    if (person.login) this.endLogin(person, 'login_failed', true, true);
    const proc = this.ensureProc(person, false);
    const login: Login = {
      code: deferred<string>(),
      expiry: setTimeout(() => { if (person.login === login) this.endLogin(person, 'login_failed', true); }, this.settings.loginTtlMs),
    };
    login.expiry.unref();
    person.login = login;
    this.send(proc, { type: 'login.start' });
    this.touch(person, proc);
    const timeout = setTimeout(() => login.code.reject(new EngineError('engine_unavailable')), this.settings.replyTimeoutMs);
    timeout.unref();
    try {
      const userCode = await login.code.promise;
      return { user_code: userCode, verification_uri: DEVICE_VERIFICATION_URI, expires_in: this.settings.loginTtlMs / 1000 };
    } catch (error) {
      if (person.login === login) this.endLogin(person, 'engine_unavailable', true);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Removes the stored credential, stops the person's process and revokes its token. */
  disconnect(subject: string): void {
    const person = this.people.get(subject);
    if (person) this.stop(person, 'disconnect');
    this.vault.delete(subject);
    if (person) {
      person.reconnect = false;
      this.forget(person);
    }
  }

  /**
   * Runs one turn. Refusals are thrown before anything is streamed; after that every
   * outcome, failures included, arrives through the sink. Resolves when the turn ends.
   */
  prompt(subject: string, text: string, systemPrompt: string, sink: TurnSink): Promise<void> {
    if (this.closed) throw new EngineError('engine_unavailable');
    if (this.people.get(subject)?.proc?.turn) throw new EngineError('turn_in_progress');
    if (!this.hasCredential(subject)) throw new EngineError('not_connected');
    const person = this.personOf(subject);
    if (person.proc && !person.login && Date.now() - person.proc.startedAt > this.settings.maxAgeMs - this.settings.refreshMarginMs) {
      this.stop(person, 'max_age');
    }
    const proc = this.ensureProc(person, true);
    if (!proc.token) {
      proc.token = this.tokens.mint(subject, this.settings.maxAgeMs);
      this.send(proc, { type: 'start', mcpUrl: this.settings.mcpUrl, mcpToken: proc.token, systemPrompt });
    }
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => this.limitTurn(person, proc), this.settings.turnTimeoutMs);
      timeout.unref();
      proc.turn = { sink, end: resolve, bytes: 0, limited: false, timeout };
      this.send(proc, { type: 'prompt', text });
      this.touch(person, proc);
    });
  }

  /** Asks the running turn of this person to stop. False when there is none. */
  abort(subject: string): boolean {
    const person = this.people.get(subject);
    const proc = person?.proc;
    if (!person || !proc?.turn) return false;
    this.requestAbort(person, proc, 'abort_timeout');
    return true;
  }

  /**
   * Stops every process and revokes every token; the manager accepts no work afterwards.
   * Resolves when every process is gone, which waits (bounded) for a refresh in flight.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const person of this.people.values()) this.stop(person, 'shutdown');
    this.people.clear();
    await Promise.all([...this.alive].map((proc) => new Promise<void>((resolve) => {
      if (proc.exited) return resolve();
      proc.child.once('exit', () => resolve());
    })));
    managers.delete(this);
  }

  /** Last resort at process exit: nothing can be waited for any more. */
  killAll(): void {
    for (const proc of this.alive) proc.child.kill('SIGKILL');
  }

  private personOf(subject: string): Person {
    let person = this.people.get(subject);
    if (!person) {
      person = { subject, reconnect: false, loginStarts: [] };
      this.people.set(subject, person);
    }
    return person;
  }

  /** True when a credential file exists, readable or not. */
  private hasCredential(subject: string): boolean {
    try {
      return this.vault.read(subject) !== null;
    } catch {
      this.personOf(subject).reconnect = true;
      throw new EngineError('reconnect');
    }
  }

  /** Drops the entry of a person the manager no longer needs to remember anything about. */
  private forget(person: Person): void {
    const now = Date.now();
    person.loginStarts = person.loginStarts.filter((at) => now - at < this.settings.loginWindowMs);
    if (person.proc || person.login || person.refreshing || person.reconnect || person.loginStarts.length > 0) return;
    if (this.people.get(person.subject) === person) this.people.delete(person.subject);
  }

  private sweep(): void {
    for (const person of [...this.people.values()]) this.forget(person);
  }

  private ensureProc(person: Person, forTurn: boolean): Proc {
    if (this.closed) throw new EngineError('engine_unavailable');
    if (person.proc) return person.proc;
    if (this.liveCount() >= this.settings.maxProcesses && forTurn) this.evictPendingLogin();
    if (this.liveCount() >= this.settings.maxProcesses) {
      this.forget(person);
      throw new EngineError('busy');
    }
    // An explicit, minimal environment: no provider key of the operator can reach the
    // engine, and stderr is discarded because provider errors can quote response bodies.
    const child = spawn(process.execPath, [this.settings.entry], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '' } });
    const proc: Proc = {
      child, decoder: new LineDecoder(), startedAt: Date.now(), toolsChecked: false, refreshes: new Map(),
      stopped: false, discard: false, exited: false,
    };
    person.proc = proc;
    this.alive.add(proc);
    const gone = (reason: string) => {
      proc.exited = true;
      this.alive.delete(proc);
      for (const reply of proc.refreshes.values()) reply.reject(new EngineError('reconnect'));
      this.stop(person, reason, proc);
    };
    child.on('error', () => gone('spawn_error'));
    child.on('exit', () => gone('exit'));
    child.stdin!.on('error', () => { /* the process is gone; `exit` cleans up */ });
    child.stdout!.on('data', (chunk: Buffer) => {
      let values: unknown[];
      try {
        values = proc.decoder.push(chunk);
      } catch {
        return this.stop(person, 'protocol', proc);
      }
      for (const value of values) {
        const message = parseChildMessage(value);
        if (!message) continue;
        // A stopped process is heard only for the refresh it was already asked for.
        if (!proc.stopped || message.type === 'refresh.done' || message.type === 'refresh.failed') this.handle(person, proc, message);
      }
    });
    this.log('start', 'first_use');
    this.touch(person, proc);
    return proc;
  }

  /** A turn of a connected writer comes before a process that only waits for a device code. */
  private evictPendingLogin(): void {
    let oldest: Person | undefined;
    for (const person of this.people.values()) {
      if (!person.proc || !person.login || person.proc.turn) continue;
      if (!oldest || person.proc.startedAt < oldest.proc!.startedAt) oldest = person;
    }
    if (oldest) this.endLogin(oldest, 'busy', true);
  }

  private handle(person: Person, proc: Proc, message: ChildMessage): void {
    switch (message.type) {
      case 'ready':
        return;
      case 'login.code':
        if (person.login) {
          person.login.userCode = message.userCode;
          person.login.code.resolve(message.userCode);
        }
        return;
      case 'login.done':
        if (!person.login) return;
        try {
          this.vault.write(person.subject, message.credential);
          person.reconnect = false;
          this.endLogin(person, 'login_failed', false);
        } catch {
          this.endLogin(person, 'engine_unavailable', false);
        }
        return;
      case 'login.failed':
        if (person.login) this.endLogin(person, 'login_failed', false);
        return;
      case 'refresh.done':
        proc.refreshes.get(message.id)?.resolve(message.credential);
        return;
      case 'refresh.failed':
        proc.refreshes.get(message.id)?.reject(new EngineError('reconnect'));
        return;
      case 'token.get':
        void this.answerToken(person, proc, message.id);
        return;
      case 'session':
        // Fail closed: the engine may hold RE;write's MCP tools and nothing else.
        if (message.tools.length === 0 || message.tools.some((tool) => !tool.startsWith(MCP_TOOL_PREFIX))) {
          return this.stop(person, 'unexpected_tools');
        }
        proc.toolsChecked = true;
        return;
      case 'delta': {
        const turn = proc.turn;
        if (!turn || turn.limited || !proc.toolsChecked) return;
        turn.bytes += Buffer.byteLength(message.text, 'utf8');
        if (turn.bytes > this.settings.turnMaxBytes) return this.limitTurn(person, proc);
        turn.sink.event('delta', { text: message.text });
        return;
      }
      case 'tool':
        if (proc.toolsChecked && proc.turn && !proc.turn.limited) {
          proc.turn.sink.event('tool', { name: message.name.replace(MCP_TOOL_PREFIX, ''), ok: message.ok });
        }
        return;
      case 'done':
        if (!proc.toolsChecked) return this.stop(person, 'unexpected_tools');
        return this.endTurn(person, proc, 'done', { aborted: message.aborted });
      case 'error':
        if (message.code === 'reconnect') person.reconnect = true;
        return this.endTurn(person, proc, 'error', { code: message.code });
    }
  }

  private async answerToken(person: Person, proc: Proc, id: string): Promise<void> {
    try {
      const credential = await this.freshCredential(person, proc);
      this.send(proc, { type: 'token', id, access: credential.access, accountId: credential.accountId, expires: credential.expires });
    } catch (error) {
      this.send(proc, { type: 'token', id, error: error instanceof EngineError ? error.code : 'engine_unavailable' });
    }
  }

  /** Single flight: every caller that arrives during a refresh waits for that one refresh. */
  private freshCredential(person: Person, proc: Proc): Promise<StoredCredential> {
    if (person.refreshing) return person.refreshing;
    let credential: StoredCredential | null;
    try {
      credential = this.vault.read(person.subject);
    } catch {
      person.reconnect = true;
      return Promise.reject(new EngineError('reconnect'));
    }
    if (!credential) return Promise.reject(new EngineError('not_connected'));
    if (credential.expires - Date.now() > this.settings.refreshMarginMs) return Promise.resolve(credential);
    const refreshing = this.refresh(person, proc, credential).finally(() => {
      if (person.refreshing === refreshing) person.refreshing = undefined;
      this.forget(person);
    });
    refreshing.catch(() => {});
    person.refreshing = refreshing;
    return refreshing;
  }

  private async refresh(person: Person, proc: Proc, credential: StoredCredential): Promise<StoredCredential> {
    const id = randomUUID();
    const reply = deferred<StoredCredential>();
    proc.refreshes.set(id, reply);
    const timeout = setTimeout(() => reply.reject(new EngineError('reconnect')), this.settings.replyTimeoutMs);
    timeout.unref();
    this.send(proc, { type: 'refresh', id, credential });
    try {
      const next = await reply.promise;
      // The old refresh token is spent once the new one exists, so the new one is stored
      // even if the process was stopped meanwhile. Only a disconnect throws it away.
      if (proc.discard) throw new EngineError('reconnect');
      this.vault.write(person.subject, next);
      person.reconnect = false;
      return next;
    } catch {
      // The stored credential is left as it was; the writer has to connect again.
      if (!proc.discard) person.reconnect = true;
      throw new EngineError('reconnect');
    } finally {
      clearTimeout(timeout);
      proc.refreshes.delete(id);
    }
  }

  /**
   * Ends a login. A process that is left with no pending login and no stored credential
   * has nothing to do and is stopped, unless `keepProcess` (a new login follows at once).
   */
  private endLogin(person: Person, code: EngineErrorCode, cancel: boolean, keepProcess = false): void {
    const login = person.login;
    if (!login) return;
    person.login = undefined;
    clearTimeout(login.expiry);
    login.code.reject(new EngineError(code));
    if (cancel && person.proc) this.send(person.proc, { type: 'login.cancel' });
    if (keepProcess || !person.proc || person.proc.turn) return;
    let connected = true;
    try { connected = this.vault.read(person.subject) !== null; } catch { /* a file exists */ }
    if (!connected) this.stop(person, 'login_ended');
  }

  /** The turn passed its time or size limit: ask it to stop, and stop the process if it does not. */
  private limitTurn(person: Person, proc: Proc): void {
    const turn = proc.turn;
    if (!turn || turn.limited) return;
    turn.limited = true;
    this.requestAbort(person, proc, 'turn_limit');
  }

  private requestAbort(person: Person, proc: Proc, reason: string): void {
    if (!proc.turn) return;
    this.send(proc, { type: 'abort' });
    proc.turn.abortTimer ??= setTimeout(() => this.stop(person, reason, proc), this.settings.abortGraceMs);
    proc.turn.abortTimer.unref();
  }

  private endTurn(person: Person, proc: Proc, name: 'done' | 'error', data: object): void {
    const turn = proc.turn;
    if (!turn) return;
    proc.turn = undefined;
    clearTimeout(turn.timeout);
    clearTimeout(turn.abortTimer);
    if (turn.limited) turn.sink.event('error', { code: 'turn_limit' });
    else turn.sink.event(name, data);
    turn.end();
    this.touch(person, proc);
  }

  private touch(person: Person, proc: Proc): void {
    clearTimeout(proc.idle);
    if (proc.stopped) return;
    proc.idle = setTimeout(() => {
      // A pending login has its own deadline, and a turn its own limit.
      if (proc.turn || person.login) return this.touch(person, proc);
      this.stop(person, 'idle');
    }, this.settings.idleMs);
    proc.idle.unref();
  }

  private send(proc: Proc, message: ParentMessage): void {
    if (proc.stopped || proc.exited || !proc.child.stdin?.writable) return;
    proc.child.stdin.write(encode(message));
  }

  /**
   * Detaches a process from its person at once: the slot is free, the token is revoked,
   * the turn and the login end. The process itself is torn down right away, unless a
   * refresh was already sent to it: then it is kept, bounded, until that refresh is back.
   */
  private stop(person: Person, reason: string, only?: Proc): void {
    const proc = only ?? person.proc;
    if (!proc || proc.stopped) return;
    if (reason === 'disconnect') proc.discard = true;
    proc.stopped = true;
    if (person.proc === proc) person.proc = undefined;
    clearTimeout(proc.idle);
    if (proc.token) this.tokens.revoke(proc.token);
    this.endTurn(person, proc, 'error', { code: 'engine_unavailable' });
    if (person.login) this.endLogin(person, 'engine_unavailable', false, true);
    this.log('stop', reason);

    const teardown = () => {
      for (const reply of proc.refreshes.values()) reply.reject(new EngineError('reconnect'));
      if (proc.exited) return;
      if (proc.child.stdin?.writable) proc.child.stdin.end(encode({ type: 'shutdown' }));
      setTimeout(() => proc.child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const pending = [...proc.refreshes.values()].map((reply) => reply.promise.catch(() => {}));
    if (pending.length === 0 || proc.discard || proc.exited) teardown();
    else {
      const grace = setTimeout(teardown, this.settings.refreshGraceMs);
      // Give the refresh's own continuation (the write to the vault) its turn first.
      void Promise.all(pending).then(() => setImmediate(() => { clearTimeout(grace); teardown(); }));
    }
    this.forget(person);
  }

  /** Metadata only: no subject, no token, nothing the process said. */
  private log(action: 'start' | 'stop', reason: string): void {
    console.log(JSON.stringify({ event: 'engine.process', timestamp: new Date().toISOString(), action, reason, live: this.liveCount() }));
  }
}
