'use strict';

/**
 * A minimal Language Server Protocol client over stdio: Content-Length framing,
 * JSON-RPC requests with ids and a per-request deadline, and replies to the
 * requests a server sends to its client. Dependency-free; test code only.
 */

const { spawn } = require('node:child_process');

/** Longest accepted message body; a larger Content-Length is a protocol error. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Most stderr text kept for error messages. */
const MAX_STDERR_CHARS = 16 * 1024;
/** Deadline for the shutdown request and for the process to exit afterwards. */
const SHUTDOWN_DEADLINE_MS = 10000;

/**
 * @typedef {{ line: number, character: number }} LspPosition
 * @typedef {{ start: LspPosition, end: LspPosition }} LspRange
 */

class LspClient {
  /**
   * @param {{ command: string, args?: string[], cwd: string, env?: NodeJS.ProcessEnv,
   *   onNotification?: (method: string, params: any) => void }} options
   */
  constructor(options) {
    if (!options || typeof options.command !== 'string' || typeof options.cwd !== 'string') {
      throw new TypeError('LspClient needs { command, cwd }');
    }
    this.options = options;
    /** @type {Map<number, { method: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.exited = false;
    this.exitInfo = null;
    /** Replies to server->client requests by method; the default is `null`. */
    this.requestHandlers = {
      'workspace/configuration': (params) => (params.items || []).map(() => null),
      'workspace/workspaceFolders': () => null,
    };
    this.proc = spawn(options.command, options.args || [], {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A malformed frame is a protocol failure: every waiting request fails with it and the
    // server is stopped, rather than an exception escaping the stream handler.
    this.proc.stdout.on('data', (chunk) => {
      try {
        this.onData(chunk);
      } catch (err) {
        this.failAll(/** @type {Error} */ (err));
        this.proc.kill('SIGKILL');
      }
    });
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS);
    });
    this.proc.stdin.on('error', (err) => this.failAll(err));
    this.proc.on('error', (err) => this.failAll(err));
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.failAll(new Error(`${options.command} exited (code ${code}, signal ${signal}). stderr tail: ${this.stderr.slice(-1000)}`));
    });
  }

  /** @param {Error} err */
  failAll(err) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  /** @param {Buffer} chunk */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`LSP frame without Content-Length: ${JSON.stringify(header)}`);
      const length = Number(match[1]);
      if (length > MAX_BODY_BYTES) throw new Error(`LSP body of ${length} bytes exceeds ${MAX_BODY_BYTES}`);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.onMessage(JSON.parse(body));
    }
  }

  /** @param {any} msg */
  onMessage(msg) {
    if (msg.method !== undefined && msg.id !== undefined) {
      this.replyToServer(msg);
    } else if (msg.method !== undefined) {
      if (this.options.onNotification) this.options.onNotification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // a late reply to a request that hit its deadline
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(`LSP ${entry.method} failed: ${msg.error.message} (code ${msg.error.code})`);
        err.code = msg.error.code;
        entry.reject(err);
      } else {
        entry.resolve(msg.result === undefined ? null : msg.result);
      }
    }
  }

  /** @param {{ id: number|string, method: string, params: any }} msg */
  replyToServer(msg) {
    const handler = this.requestHandlers[msg.method];
    const result = handler ? handler(msg.params) : null;
    this.send({ jsonrpc: '2.0', id: msg.id, result });
  }

  /** @param {object} message */
  send(message) {
    if (this.exited) throw new Error('LSP server has exited');
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  /**
   * Sends a request and resolves with its `result` (`null` when the server says null).
   * Rejects on a JSON-RPC error, on server exit, or when `deadlineMs` passes (a
   * `$/cancelRequest` is sent then).
   * @param {string} method
   * @param {any} params
   * @param {number} deadlineMs
   * @returns {Promise<any>}
   */
  request(method, params, deadlineMs) {
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
      throw new RangeError(`request deadline must be a positive integer of ms, got ${deadlineMs}`);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!this.exited) this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        const err = new Error(`LSP ${method} exceeded its ${deadlineMs} ms deadline`);
        err.code = 'DEADLINE';
        reject(err);
      }, deadlineMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * @param {string} method
   * @param {any} params
   */
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * initialize + initialized.
   * @param {{ rootPath: string, rootUri: string, deadlineMs: number, initializationOptions?: any }} options
   * @returns {Promise<any>} the server's capabilities
   */
  async initialize(options) {
    const result = await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'impact-tree-lsp-harness', version: '0' },
      rootPath: options.rootPath,
      rootUri: options.rootUri,
      workspaceFolders: [{ uri: options.rootUri, name: 'workspace' }],
      initializationOptions: options.initializationOptions || {},
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true },
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
          references: {},
          implementation: { linkSupport: false },
        },
      },
    }, options.deadlineMs);
    this.notify('initialized', {});
    return result;
  }

  /**
   * @param {{ uri: string, languageId: string, version?: number, text: string }} doc
   */
  didOpen(doc) {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version || 1, text: doc.text },
    });
  }

  /** @param {string} uri */
  didClose(uri) {
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /** shutdown + exit, then kill if the process does not leave in time. Never throws. */
  async close() {
    if (this.exited) return;
    try {
      await this.request('shutdown', null, SHUTDOWN_DEADLINE_MS);
      this.notify('exit', null);
    } catch (err) {
      // The server may be wedged or gone; the kill below is the guaranteed path.
      this.shutdownError = err;
    }
    await new Promise((resolve) => {
      if (this.exited) { resolve(); return; }
      const timer = setTimeout(() => { this.proc.kill('SIGKILL'); }, SHUTDOWN_DEADLINE_MS);
      this.proc.once('exit', () => { clearTimeout(timer); resolve(); });
      if (this.shutdownError) this.proc.kill('SIGKILL');
    });
  }
}

module.exports = { LspClient };
