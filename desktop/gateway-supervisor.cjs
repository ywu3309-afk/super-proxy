'use strict';

// Process lifecycle only: account storage, ports and transport belong to launch().
function createGatewaySupervisor({ launch, onState = () => {}, onFailure = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  maxRestarts = 3, restartWindowMs = 300000, retryDelayMs = 1000 }) {
  let state = 'idle';
  let stopped = false;
  let operation = null;
  let current = null;
  let launching = null;
  let timer = null;
  let restartTimes = [];

  const publish = (next, details = {}) => { state = next; onState(next, details); };
  const dispose = (record) => {
    if (!record) return Promise.resolve();
    record.disposal ||= Promise.resolve().then(() => record.resource.dispose()).catch(error => {
      const fatal = new Error(`网关清理失败：${error.message}`, { cause: error });
      fatal.gatewayCleanupFailed = true;
      throw fatal;
    }).finally(() => {
      record.resource.child.removeListener('exit', record.onExit);
      record.resource.child.removeListener('error', record.onError);
    });
    return record.disposal;
  };
  const fail = (error) => {
    if (stopped) return;
    publish('failed', { error });
    onFailure(error);
  };
  const schedule = (error) => {
    if (stopped || timer !== null) return;
    if (error?.gatewayCleanupFailed) return fail(error);
    restartTimes = restartTimes.filter(time => now() - time < restartWindowMs);
    if (restartTimes.length >= maxRestarts) return fail(error);
    const attempt = restartTimes.length + 1;
    const delayMs = retryDelayMs * (2 ** (attempt - 1));
    publish('recovering', { error, attempt, delayMs, maxRestarts });
    timer = setTimer(() => {
      timer = null;
      if (stopped) return;
      restartTimes.push(now());
      run(true).catch(schedule);
    }, delayMs);
  };

  async function startOnce(recovery) {
    const controller = new AbortController();
    launching = controller;
    let record;
    publish(recovery ? 'restarting' : 'starting');
    try {
      const resource = await launch({ signal: controller.signal });
      let rejectExit;
      const exited = new Promise((resolve, reject) => { rejectExit = reject; });
      // Attach before invoking ready(): an error/exit must beat an unrelated HTTP 200.
      record = { resource, controller, ready: false, ended: false };
      const ended = (error) => {
        if (record.ended) return;
        record.ended = true;
        controller.abort(error);
        if (!record.ready) rejectExit(error);
        else if (!stopped && current === record) {
          current = null;
          publish('offline', { error });
          dispose(record).then(() => schedule(error), fail);
        }
      };
      record.onExit = (code, signal) => ended(new Error(`网关进程退出（code=${code}, signal=${signal || 'none'}）`));
      record.onError = (error) => ended(error);
      resource.child.on('exit', record.onExit);
      resource.child.on('error', record.onError);
      current = record;
      if (stopped || controller.signal.aborted) throw controller.signal.reason || new Error('网关已停止');
      if (resource.child.exitCode != null || resource.child.signalCode != null) {
        throw new Error('网关进程在启动期间退出');
      }
      await Promise.race([Promise.resolve().then(() => resource.ready(controller.signal)), exited]);
      if (stopped || record.ended || controller.signal.aborted) throw controller.signal.reason || new Error('网关已停止');
      record.ready = true;
      publish('running', { info: resource.info, resource, recovered: recovery });
      return resource.info;
    } catch (error) {
      if (current === record) current = null;
      controller.abort(error);
      await dispose(record);
      throw error;
    } finally {
      if (launching === controller) launching = null;
    }
  }

  function run(recovery) {
    if (operation) return operation;
    const pending = startOnce(recovery);
    operation = pending.finally(() => { operation = null; });
    return operation;
  }

  return {
    start() {
      if (stopped) return Promise.reject(new Error('网关监督器已停止'));
      if (operation) return operation;
      if (state === 'running' && current) return Promise.resolve(current.resource.info);
      if (timer !== null || ['offline', 'recovering', 'restarting', 'failed'].includes(state)) {
        return Promise.reject(new Error('网关正在恢复或已达到恢复上限'));
      }
      return run(false);
    },
    async stop() {
      stopped = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      launching?.abort(new Error('桌面程序正在退出'));
      const record = current;
      current = null;
      record?.controller.abort(new Error('桌面程序正在退出'));
      publish('stopped');
      await Promise.all([dispose(record), operation?.catch(() => {})]);
    },
    get state() { return state; }
  };
}

module.exports = { createGatewaySupervisor };
