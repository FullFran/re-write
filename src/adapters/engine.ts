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
  turn_in_progress: 409,
  not_connected: 409,
  reconnect: 409,
  engine_unavailable: 503,
  model_busy: 503,
  provider_error: 502,
  login_failed: 502,
};

export type EngineStatus =
  | { state: 'disconnected' | 'connected' | 'reconnect' }
  | { state: 'pending'; user_code?: string; verification_uri: string };

export interface TurnSink {
  event(name: 'delta' | 'tool' | 'done' | 'error', data: object): void;
}

const LOGIN_TTL_MS = 15 * 60_000;
const ABORT_GRACE_MS = 5_000;
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
  stopped: boolean;
}

interface Person {
  subject: string;
  proc?: Proc;
  login?: Login;
  reconnect: boolean;
  refreshing?: Promise<StoredCredential>;
}

const managers = new Set<EngineManager>();
// A server that exits must not leave engine processes behind.
process.once('exit', () => managers.forEach((manager) => manager.close()));

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
  private closed = false;

  constructor(settings: EngineSettings) {
    this.settings = { maxAgeMs: 60 * 60_000, refreshMarginMs: 10 * 60_000, replyTimeoutMs: 60_000, ...settings };
    this.vault = new CredentialVault(settings.dataDir, settings.key);
    managers.add(this);
  }

  liveCount(): number {
    let count = 0;
    for (const person of this.people.values()) if (person.proc) count += 1;
    return count;
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

  /** Starts a device-code login. One at a time per person: a new one cancels the previous. */
  async startLogin(subject: string): Promise<{ user_code: string; verification_uri: string; expires_in: number }> {
    const person = this.personOf(subject);
    if (person.login) this.endLogin(person, 'login_failed', true);
    const proc = this.ensureProc(person);
    const login: Login = {
      code: deferred<string>(),
      expiry: setTimeout(() => { if (person.login === login) this.endLogin(person, 'login_failed', true); }, LOGIN_TTL_MS),
    };
    login.expiry.unref();
    person.login = login;
    this.send(proc, { type: 'login.start' });
    this.touch(person, proc);
    const timeout = setTimeout(() => login.code.reject(new EngineError('engine_unavailable')), this.settings.replyTimeoutMs);
    timeout.unref();
    try {
      const userCode = await login.code.promise;
      return { user_code: userCode, verification_uri: DEVICE_VERIFICATION_URI, expires_in: LOGIN_TTL_MS / 1000 };
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
    if (person) {
      this.stop(person, 'disconnect');
      this.people.delete(subject);
    }
    this.vault.delete(subject);
  }

  /**
   * Runs one turn. Refusals are thrown before anything is streamed; after that every
   * outcome, failures included, arrives through the sink. Resolves when the turn ends.
   */
  prompt(subject: string, text: string, systemPrompt: string, sink: TurnSink): Promise<void> {
    if (this.closed) throw new EngineError('engine_unavailable');
    const person = this.personOf(subject);
    if (person.proc?.turn) throw new EngineError('turn_in_progress');
    if (!this.credentialOf(person)) throw new EngineError('not_connected');
    if (person.proc && !person.login && Date.now() - person.proc.startedAt > this.settings.maxAgeMs - this.settings.refreshMarginMs) {
      this.stop(person, 'max_age');
    }
    const proc = this.ensureProc(person);
    if (!proc.token) {
      proc.token = this.tokens.mint(subject, this.settings.maxAgeMs);
      this.send(proc, { type: 'start', mcpUrl: this.settings.mcpUrl, mcpToken: proc.token, systemPrompt });
    }
    return new Promise<void>((resolve) => {
      proc.turn = { sink, end: resolve };
      this.send(proc, { type: 'prompt', text });
      this.touch(person, proc);
    });
  }

  /** Asks the running turn of this person to stop. False when there is none. */
  abort(subject: string): boolean {
    const person = this.people.get(subject);
    const proc = person?.proc;
    if (!person || !proc?.turn) return false;
    this.send(proc, { type: 'abort' });
    proc.turn.abortTimer ??= setTimeout(() => this.stop(person, 'abort_timeout'), ABORT_GRACE_MS);
    proc.turn.abortTimer.unref();
    return true;
  }

  /** Stops every process and revokes every token. The manager accepts no work afterwards. */
  close(): void {
    this.closed = true;
    for (const person of this.people.values()) this.stop(person, 'shutdown', true);
    this.people.clear();
    managers.delete(this);
  }

  private personOf(subject: string): Person {
    let person = this.people.get(subject);
    if (!person) {
      person = { subject, reconnect: false };
      this.people.set(subject, person);
    }
    return person;
  }

  private credentialOf(person: Person): StoredCredential | null {
    try {
      return this.vault.read(person.subject);
    } catch {
      person.reconnect = true;
      throw new EngineError('reconnect');
    }
  }

  private ensureProc(person: Person): Proc {
    if (this.closed) throw new EngineError('engine_unavailable');
    if (person.proc) return person.proc;
    if (this.liveCount() >= this.settings.maxProcesses) throw new EngineError('busy');
    // An explicit, minimal environment: no provider key of the operator can reach the
    // engine, and stderr is discarded because provider errors can quote response bodies.
    const child = spawn(process.execPath, [this.settings.entry], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '' } });
    const proc: Proc = { child, decoder: new LineDecoder(), startedAt: Date.now(), toolsChecked: false, refreshes: new Map(), stopped: false };
    person.proc = proc;
    child.on('error', () => this.stop(person, 'spawn_error', true, proc));
    child.on('exit', () => this.stop(person, 'exit', true, proc));
    child.stdin!.on('error', () => { /* the process is gone; `exit` cleans up */ });
    child.stdout!.on('data', (chunk: Buffer) => {
      let values: unknown[];
      try {
        values = proc.decoder.push(chunk);
      } catch {
        return this.stop(person, 'protocol', true, proc);
      }
      for (const value of values) {
        const message = parseChildMessage(value);
        if (message && !proc.stopped) this.handle(person, proc, message);
      }
    });
    this.log('start', 'first_use');
    this.touch(person, proc);
    return proc;
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
      case 'delta':
        if (proc.toolsChecked) proc.turn?.sink.event('delta', { text: message.text });
        return;
      case 'tool':
        if (proc.toolsChecked) proc.turn?.sink.event('tool', { name: message.name.replace(MCP_TOOL_PREFIX, ''), ok: message.ok });
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
    const credential = this.credentialOf(person);
    if (!credential) return Promise.reject(new EngineError('not_connected'));
    if (credential.expires - Date.now() > this.settings.refreshMarginMs) return Promise.resolve(credential);
    const refreshing = this.refresh(person, proc, credential).finally(() => {
      if (person.refreshing === refreshing) person.refreshing = undefined;
    });
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
      // A disconnect during the exchange wins: nothing is written back.
      if (proc.stopped) throw new EngineError('reconnect');
      this.vault.write(person.subject, next);
      person.reconnect = false;
      return next;
    } catch {
      // The stored credential is left as it was; the writer has to connect again.
      person.reconnect = true;
      throw new EngineError('reconnect');
    } finally {
      clearTimeout(timeout);
      proc.refreshes.delete(id);
    }
  }

  private endLogin(person: Person, code: EngineErrorCode, cancel: boolean): void {
    const login = person.login;
    if (!login) return;
    person.login = undefined;
    clearTimeout(login.expiry);
    login.code.reject(new EngineError(code));
    if (cancel && person.proc) this.send(person.proc, { type: 'login.cancel' });
  }

  private endTurn(person: Person, proc: Proc, name: 'done' | 'error', data: object): void {
    const turn = proc.turn;
    if (!turn) return;
    proc.turn = undefined;
    clearTimeout(turn.abortTimer);
    turn.sink.event(name, data);
    turn.end();
    this.touch(person, proc);
  }

  private touch(person: Person, proc: Proc): void {
    clearTimeout(proc.idle);
    if (proc.stopped) return;
    proc.idle = setTimeout(() => {
      if (proc.turn || person.login) return this.touch(person, proc);
      this.stop(person, 'idle');
    }, this.settings.idleMs);
    proc.idle.unref();
  }

  private send(proc: Proc, message: ParentMessage): void {
    if (proc.stopped || !proc.child.stdin?.writable) return;
    proc.child.stdin.write(encode(message));
  }

  private stop(person: Person, reason: string, force = false, only?: Proc): void {
    const proc = only ?? person.proc;
    if (!proc || proc.stopped) return;
    this.send(proc, { type: 'shutdown' });
    proc.stopped = true;
    if (person.proc === proc) person.proc = undefined;
    clearTimeout(proc.idle);
    if (proc.token) this.tokens.revoke(proc.token);
    for (const reply of proc.refreshes.values()) reply.reject(new EngineError('reconnect'));
    this.endTurn(person, proc, 'error', { code: 'engine_unavailable' });
    if (person.login) this.endLogin(person, 'engine_unavailable', false);
    proc.child.stdin?.end();
    if (force) proc.child.kill('SIGKILL');
    else setTimeout(() => proc.child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    this.log('stop', reason);
  }

  /** Metadata only: no subject, no token, nothing the process said. */
  private log(action: 'start' | 'stop', reason: string): void {
    console.log(JSON.stringify({ event: 'engine.process', timestamp: new Date().toISOString(), action, reason, live: this.liveCount() }));
  }
}
