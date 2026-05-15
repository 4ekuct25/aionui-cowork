/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const uuid = (len = 4) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    const bytes = crypto.randomBytes(Math.ceil(len / 2));
    return bytes.toString('hex').slice(0, len);
  } catch {
    const ts = Date.now().toString(16);
    return ts.slice(-len).padStart(len, '0');
  }
};

const callbackKey = (key: string) => key + '.callback';

/* eslint-disable unicorn/no-thenable -- Deferred intentionally implements thenable interface */
class Deferred {
  resolve: (data: any) => void;
  reject: (data: any) => void;
  private _promise: Promise<any>;
  private key: string;
  constructor(key: string) {
    this._promise = new Promise((resolve, reject) => {
      this.resolve = (data: any) => {
        resolve(data);
      };
      this.reject = (data: any) => {
        reject(data);
      };
    });
    this.key = key;
  }
  promise() {
    return this._promise;
  }
  then(onfulfilled: (data: any) => void, onrejected?: (data: any) => void) {
    return this._promise.then(onfulfilled, onrejected);
  }
  catch(onrejected: (data: any) => void) {
    return this._promise.catch(onrejected);
  }
  finally(onfinally: () => void) {
    return this._promise.finally(onfinally);
  }
  with(promise: Promise<any>) {
    promise.then(this.resolve).catch(this.reject);
  }
  pipe(handler: (key: string, data: { data: any; state: 'fulfilled' | 'rejected' }) => void) {
    const key = callbackKey(this.key);
    return this.promise()
      .then((data) => handler(key, { data, state: 'fulfilled' }))
      .catch((data) => handler(key, { data, state: 'rejected' }));
  }
}

type THandler = (data: any, deferred?: Deferred) => void;

/**
 * Detect whether this worker was spawned through DockerPlatformServices.
 * The parent sets AIONUI_TRANSPORT=docker on the exec env so the worker
 * knows to talk NDJSON over stdin/stdout instead of using parentPort or
 * `process.send` (neither of which exists across a docker exec boundary).
 */
function isDockerTransport(): boolean {
  return (process.env.AIONUI_TRANSPORT ?? '').trim().toLowerCase() === 'docker';
}

export class Pipe {
  listener: {
    [key: string]: Array<THandler>;
  } = {};
  isClose = false;
  constructor(master = false) {
    if (!master) {
      // Handle message from main process
      const handleMessage = (msgData: any) => {
        const { type, data, pipeId } = msgData || {};
        if (type) {
          const deferred = this.deferred(pipeId);
          if (pipeId) {
            deferred.pipe(this.call.bind(this)).catch((error: Error) => {
              console.error('Failed to pipe deferred call:', error);
            });
          }
          this.emit(type, data, deferred);
        }
      };

      if (isDockerTransport()) {
        // Docker exec transport: parent attached stdin (rw) + stdout (multiplexed).
        // Each message is a single newline-terminated JSON object. Stick to
        // process.stdin events rather than readline to keep the dep surface
        // minimal — workers run inside a slim container image.
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              handleMessage(JSON.parse(trimmed));
            } catch (err) {
              console.error('Worker stdin: malformed JSON, dropped:', err);
            }
          }
        });
        // EOF on stdin = parent disconnected; exit cleanly so the container
        // doesn't keep a zombie worker process around.
        process.stdin.on('end', () => process.exit(0));
      } else if (process.parentPort) {
        // Electron utility process: message is wrapped in a MessageEvent
        process.parentPort.on('message', (event) => {
          handleMessage(event.data);
        });
      } else {
        // Node.js child_process.fork: message is the data directly
        process.on('message', (message) => {
          handleMessage(message);
        });
      }
    }
  }
  emit(name: string, data: any, deferred?: Deferred) {
    const listener = (this.listener[name] || []).slice();
    for (let i = 0, len = listener.length; i < len; i++) {
      listener[i](data, deferred);
    }
  }

  on(name: string, handler: THandler) {
    const events = this.listener[name] || (this.listener[name] = []);
    events.push(handler);
    return () => {
      this.off(name, handler);
    };
  }
  once(name: string, handler: THandler) {
    const wrapper: THandler = (...args) => {
      this.off(name, wrapper);
      handler(...args);
    };
    this.on(name, wrapper);
  }
  deferred(key?: string) {
    return new Deferred(key);
  }
  callbackKey(key: string) {
    return callbackKey(key);
  }
  off(name: string, handler?: THandler) {
    if (!this.listener[name] || !handler) this.listener[name] = [];
    else this.listener[name] = this.listener[name].filter((h) => h !== handler);
  }
  /**
   * 向主线程发起通知
   * @param name 通知名称
   * @param data 通知数据
   * @param extPrams 扩展参数
   */
  call(name: string, data: any, extPrams: any = {}) {
    if (this.isClose) {
      console.log('---主进程已关闭', name, '执行失败！!');
      return;
    }
    const msg = { type: name, data: data, ...extPrams };
    if (isDockerTransport()) {
      // Docker exec transport: emit one JSON line. We deliberately bypass
      // console.* to avoid mixing log output into the protocol stream.
      try {
        process.stdout.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        // EPIPE is the normal "parent went away" signal — exit instead of
        // looping on broken pipes.
        if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') {
          process.exit(0);
        }
        throw err;
      }
    } else if (process.parentPort?.postMessage) {
      // Electron utility process
      process.parentPort.postMessage(msg);
    } else if (process.send) {
      // Node.js child_process.fork
      process.send(msg);
    } else {
      console.error('---非子线程，无法使用主线程事件机制');
    }
  }
  // 向主线程发起通知,并建立响应机制
  callPromise<T = any>(name: string, data: any) {
    const pipeId = uuid(8);
    this.call(name, data, {
      pipeId,
    });
    const promise = new Promise<T>((resolve, reject) => {
      this.once(callbackKey(pipeId), (data) => {
        if (data.type === 'fulfilled') {
          resolve(data.data);
        } else {
          reject(data.data);
        }
      });
    });
    return promise;
  }
  log(...args: any[]) {
    this.call('log', args);
  }
  clear() {
    this.listener = {};
  }
}

export default new Pipe();
