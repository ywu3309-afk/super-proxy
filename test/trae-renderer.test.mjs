import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { performTraeOperation } = require('../desktop/trae-renderer.cjs');
const moduleUrl = 'vscode-file://vscode-app/c:/fixture/workbench.desktop.main.js';
const uid = 'fixture-user';
const modelId = 'glm-5.3-flashx';
const input = { operation: 'chat', uid, model: modelId, prompt: 'Return MODEL_OK', maxChars: 1024, timeoutMs: 1000 };
const preset = (name = modelId, extra = {}) => ({ name, display_name: name.toUpperCase(),
  is_preset: true, status: true, selectable: true, config_source: 1, ...extra });
const event = (kind, payload = {}) => ({ event: kind, payload });
const modelConfig = () => event('model_config', { config_name: modelId, model_name: modelId + '__dev' });
const final = (text = 'MODEL_OK') => event('plan_item', { tool_call_info: { name: 'finish', params: { summary: text } } });
const done = () => event('done', { status: 'completed' });

function runtime(options = {}) {
  const calls = [], payloads = [];
  let cancelCount = 0, unsubscribeCount = 0, stopResolved = false;
  const nativePayload = { client_info: { workspace_folder: 'private-folder', workspace_folders: ['private'],
    git_repos: ['private-git'], local_git_repos: ['private-local'], git_metadata_dirs: ['private-meta'],
    security_rules: ['private-rule'], workspace_id: 'private-workspace', enable_browser_tools: true,
    permission_profile_id: 'full_access', safe_field: 'retained' } };
  const stream = {
    subscribe(observer) {
      if (options.subscribeThrows) throw new Error('private-target-secret');
      queueMicrotask(() => {
        for (const value of options.events ?? [modelConfig(),
          event('plan_item', { thought: 'MODEL' }), final(), event('token_usage', { input: '9', output: '3' }), done()]) {
          observer.onMessage(value);
        }
        if (options.onError) observer.onError(new Error('private-target-secret'));
        else if (options.onCancel) observer.onCancel();
        else if (!options.hang) observer.onComplete();
      });
      return { unsubscribe() { unsubscribeCount++; } };
    },
    cancel() { cancelCount++; }
  };
  const client = {
    createUserInfo() { return { user_id: options.currentUid ?? uid, token: 'private-target-secret' }; },
    convertReqToRustPayload() { return options.asyncPayload ? Promise.resolve(nativePayload) : nativePayload; },
    async request(request) {
      calls.push(request);
      payloads.push(await this.convertReqToRustPayload(request));
      switch (request.method) {
        case 'model_list_by_function':
          if (options.catalogThrows) throw new Error('private-target-secret');
          return options.catalogResponse ?? { code: 0, data: { list: [{ function: 'chat_v3', models: options.models ?? [preset()] }] } };
        case 'get_or_create_project_v2':
          return options.projectResponse ?? { code: 0, data: { code: 0, data: { project_id: 'fixture-project' } } };
        case 'create_session':
          return options.sessionResponse ?? { code: 0, data: { session: { session_id: 'fixture-session' } } };
        case 'stop_chat':
          if (options.stopThrows) throw new Error('private-target-secret');
          if (options.stopDelay) await new Promise((resolve) => setTimeout(resolve, options.stopDelay));
          stopResolved = true;
          return options.stopResponse ?? { code: 0, data: {} };
        default: throw new Error('unexpected fixture request');
      }
    },
    async requestForStream(request) {
      calls.push(request);
      payloads.push(await this.convertReqToRustPayload(request));
      if (options.streamThrows) throw new Error('private-target-secret');
      return stream;
    }
  };
  return { client, calls, payloads, nativePayload,
    deps: { resolveClient: async () => client },
    stats: () => ({ cancelCount, unsubscribeCount, stopResolved }),
    run: (changes = {}) => performTraeOperation({ ...input, ...changes }, moduleUrl, { resolveClient: async () => client }) };
}

test('native catalog returns sanitized exact names, not keys or raw payloads', async () => {
  const r = runtime({ models: [preset(modelId, { custom_config: '{"sk":"private-target-secret"}', extra: 'not-exported' })] });
  const result = await r.run({ operation: 'catalog' });
  assert.deepEqual(result.models, [{ upstreamId: modelId, name: modelId.toUpperCase(), route: 'native_client' }]);
  assert.equal(result.source, 'native_client');
  assert.equal(typeof result.fetchedAt, 'number');
  assert.deepEqual(r.calls.map((c) => c.method), ['model_list_by_function']);
  assert.deepEqual(r.calls[0].data, { functions: ['chat_v3'], force_refresh: true });
  assert.ok(!JSON.stringify(result).includes('private-target-secret'));
});

test('wrong current account fails before any RPC and does not disclose either UID', async () => {
  const r = runtime({ currentUid: 'other-private-user' });
  const result = await r.run();
  assert.equal(result.error.code, 'wrong_current_account');
  assert.deepEqual(r.calls, []);
  assert.ok(!JSON.stringify(result).includes(uid));
  assert.ok(!JSON.stringify(result).includes('other-private-user'));
});

test('catalog filters custom, disabled, malformed and duplicate models', async () => {
  const bad = [preset('custom_connection'), preset('provider//model'), preset('disabled', { status: false }),
    preset('non-preset', { is_preset: false }), preset('hidden', { selectable: false }),
    preset('other-source', { config_source: 2 }), preset('bad/name'), preset('long', { display_name: 'x'.repeat(161) }),
    preset('control', { display_name: 'bad\nname' }), preset('client', { client_connect: true }),
    preset('custom-base', { is_custom_base_url: true })];
  for (const field of ['is_preset', 'status', 'selectable']) {
    for (const flag of [undefined, null, false, 0, 'true']) bad.push(preset('bad-' + field, { [field]: flag }));
  }
  for (const field of ['ak', 'sk', 'base_url', 'custom_model_id', 'custom_model_type', 'provider', 'auth_type']) {
    bad.push(preset('bad-' + field, { [field]: 'private-target-secret' }));
  }
  const r = runtime({ models: [...bad, preset(), preset()] });
  assert.equal((await r.run({ operation: 'catalog' })).models.length, 1);
});

test('exact model required; no friendly alias or old-model substitution', async () => {
  const r = runtime({ models: [preset('glm-5.2')] });
  assert.equal((await r.run()).error.code, 'model_unavailable');
  assert.deepEqual(r.calls.map((c) => c.method), ['model_list_by_function']);
});

test('finish summary supersedes partial thought, preserves actual upstream name and requires completed stream', async () => {
  const r = runtime();
  const result = await r.run();
  assert.deepEqual(result, { response: 'MODEL_OK', reasoning_content: '',
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }, finish_reason: 'stop',
    upstreamModel: modelId + '__dev', model: modelId });
  assert.ok(!r.calls.some((c) => c.method === 'stop_chat'));
  assert.equal(r.stats().cancelCount, 1);
  assert.equal(r.stats().unsubscribeCount, 1);
  assert.ok(!JSON.stringify(result).includes('fixture-project'));
  assert.ok(!JSON.stringify(result).includes('fixture-session'));
});

test('plan-item thought and reasoning are replacement snapshots, not appended deltas', async () => {
  const r = runtime({ events: [modelConfig(),
    event('plan_item', { id: 'plan-a', thought: 'The', reasoning_content: 'The' }),
    event('plan_item', { id: 'plan-a', thought: 'The user', reasoning_content: 'The user' }),
    event('plan_item', { id: 'plan-a', thought: 'The user asked.', reasoning_content: 'The user asked.' }),
    final(), done()] });
  const result = await r.run();
  assert.equal(result.response, 'MODEL_OK');
  assert.equal(result.reasoning_content, 'The user asked.');
  assert.ok(!result.reasoning_content.includes('TheThe'));
});

test('snapshot updates retain missing or null fields and do not overwrite other item IDs', async () => {
  const r = runtime({ events: [modelConfig(),
    event('plan_item', { id: 'plan-a', thought: 'A', reasoning_content: 'Reason A' }),
    event('plan_item', { id: 'plan-b', thought: 'B', reasoning_content: 'Reason B' }),
    event('plan_item', { id: 'plan-a', thought: 'A2' }),
    event('plan_item', { id: 'plan-b', reasoning_content: 'Reason B2' }),
    event('plan_item', { id: 'plan-a', thought: null, reasoning_content: null }), done()] });
  const result = await r.run();
  assert.equal(result.response, 'A2B');
  assert.equal(result.reasoning_content, 'Reason AReason B2');
});

test('empty thought snapshot clears earlier partial text while final params summary remains authoritative', async () => {
  const r = runtime({ events: [modelConfig(),
    event('plan_item', { id: 'deepseek-plan', thought: 'MODEL', reasoning_content: 'Reason',
      tool_call_info: { name: '', id: 'tracking-id', params: null, result: {} } }),
    event('plan_item', { id: 'deepseek-plan', thought: '', tool_call_info: {
      name: 'finish', params: { summary: 'MODEL_OK' }, result: { data: { summary: '' } } } }), done()] });
  const result = await r.run();
  assert.equal(result.response, 'MODEL_OK');
  assert.equal(result.reasoning_content, 'Reason');
});

test('empty finish summary preserves an existing normal thought snapshot', async () => {
  const r = runtime({ events: [modelConfig(),
    event('plan_item', { id: 'same-plan', thought: 'VALID_TEXT' }),
    event('plan_item', { id: 'same-plan', tool_call_info: { name: 'finish', params: { summary: '' } } }), done()] });
  const result = await r.run();
  assert.equal(result.response, 'VALID_TEXT');
  assert.ok(!r.calls.some((call) => call.method === 'stop_chat'));
});

test('empty finish summary never revives text explicitly cleared by the latest snapshot', async () => {
  const r = runtime({ events: [modelConfig(),
    event('plan_item', { id: 'same-plan', thought: 'OLD_TEXT',
      tool_call_info: { name: 'finish', params: { summary: 'OLD_SUMMARY' } } }),
    event('plan_item', { id: 'same-plan', thought: '',
      tool_call_info: { name: 'finish', params: { summary: '' } } }), done()] });
  assert.equal((await r.run()).error.code, 'empty_response');
  assert.equal(r.stats().stopResolved, true);
});

test('non-string finish summaries remain invalid instead of activating a fallback', async () => {
  for (const summary of [null, 7, {}, []]) {
    const r = runtime({ events: [modelConfig(),
      event('plan_item', { id: 'same-plan', thought: 'VALID_TEXT',
        tool_call_info: { name: 'finish', params: { summary } } }), done()] });
    assert.equal((await r.run()).error.code, 'invalid_native_response');
    assert.equal(r.stats().stopResolved, true);
  }
});

test('snapshot aggregation still enforces the shared output budget', async () => {
  const r = runtime({ events: [modelConfig(),
    event('plan_item', { id: 'a', thought: '123' }),
    event('plan_item', { id: 'b', thought: '456' }), done()] });
  assert.equal((await r.run({ maxChars: 5 })).error.code, 'output_limit');
  assert.equal(r.stats().stopResolved, true);
});

test('empty project and side-chat session use the verified request contract', async () => {
  const r = runtime();
  await r.run();
  const project = r.calls.find((c) => c.method === 'get_or_create_project_v2');
  assert.equal(project.service, 'lite');
  assert.deepEqual(project.data, { project_kind: 'empty' });
  assert.deepEqual(project.context, {});
  const session = r.calls.find((c) => c.method === 'create_session');
  assert.deepEqual(session.data, { project_id: 'fixture-project', session_type: 'side_chat' });
  const chat = r.calls.find((c) => c.method === 'chat');
  assert.equal(chat.data.model_name, modelId);
  assert.equal(chat.data.custom_model.config_name, modelId);
  assert.equal(chat.data.custom_model.use_remote_service, true);
  assert.match(chat.data.message_id, /^[a-f0-9]{24}$/);
  assert.match(chat.data.message_content[0].text_content, /不使用任何工具/);
  assert.ok(chat.data.message_content[0].text_content.endsWith(input.prompt));
  assert.deepEqual(chat.context, { project_id: 'fixture-project', chat_session_id: 'fixture-session' });
  for (const field of ['terminal_context', 'code_selections', 'parsed_query', 'multi_media', 'workspace_folders']) {
    assert.deepEqual(chat.data[field], []);
  }
});

test('cloned client clears workspace metadata without mutating shared client or native payload', async () => {
  const r = runtime();
  const original = r.client.convertReqToRustPayload;
  await r.run();
  assert.equal(r.client.convertReqToRustPayload, original);
  assert.equal(r.nativePayload.client_info.workspace_folder, 'private-folder');
  assert.equal(r.nativePayload.client_info.enable_browser_tools, true);
  for (const payload of r.payloads) {
    assert.equal(payload.client_info.workspace_folder, '');
    assert.equal(payload.client_info.workspace_id, '');
    for (const field of ['workspace_folders', 'git_repos', 'local_git_repos', 'git_metadata_dirs', 'security_rules']) {
      assert.deepEqual(payload.client_info[field], []);
    }
    assert.equal(payload.client_info.enable_browser_tools, false);
    assert.equal(payload.client_info.permission_profile_id, 'manual_approval');
    assert.equal(payload.client_info.safe_field, 'retained');
  }
});

test('async native payload converter remains supported', async () => {
  const r = runtime({ asyncPayload: true });
  assert.equal((await r.run()).response, 'MODEL_OK');
  assert.equal(r.payloads[0].client_info.workspace_folder, '');
});

test('missing model_config cannot claim success for the selected model', async () => {
  const r = runtime({ events: [final(), done()] });
  const result = await r.run();
  assert.equal(result.error.code, 'upstream_model_unconfirmed');
  assert.ok(!('upstreamModel' in result));
  assert.equal(r.stats().stopResolved, true);
});

test('model_config must contain exact config_name and an actual valid model_name', async () => {
  for (const payload of [{ config_name: modelId }, { model_name: modelId + '__dev' },
    { config_name: modelId, model_name: '' }, { config_name: modelId, model_name: 'private\nsecret' }]) {
    const r = runtime({ events: [event('model_config', payload), final(), done()] });
    const result = await r.run();
    assert.ok(['upstream_model_unconfirmed', 'invalid_native_response'].includes(result.error.code));
    assert.ok(!('response' in result));
    assert.equal(r.stats().stopResolved, true);
  }
});

test('model_config mismatch terminates before returning another model as requested', async () => {
  const r = runtime({ events: [event('model_config', { config_name: 'other-model', model_name: 'other-model__dev' }), final(), done()] });
  assert.equal((await r.run()).error.code, 'upstream_model_mismatch');
  assert.equal(r.calls.filter((c) => c.method === 'stop_chat').length, 1);
});

test('any non-finish tool causes authoritative stop, never tool execution', async () => {
  const r = runtime({ events: [event('plan_item', { tool_call_info: { name: 'run_command', params: { command: 'private-target-secret' } } }), final(), done()] });
  const result = await r.run();
  assert.equal(result.error.code, 'tool_not_allowed');
  assert.equal(r.calls.filter((c) => c.method === 'stop_chat').length, 1);
  assert.equal(r.stats().stopResolved, true);
  assert.equal(r.stats().cancelCount, 1);
  assert.ok(!JSON.stringify(result).includes('private-target-secret'));
});

test('observed empty plan_item tool DTO is a placeholder, not a real tool', async () => {
  for (const fields of [{ id: '', params: null, result: {} },
    { id: 'nonempty-native-tracking-id', params: null, result: {}, meta: null,
      already_emitted_generating_event: false, already_emitted_run_event: false },
    { id: null, params: {}, result: {} }, { result: {} }]) {
    const r = runtime({ events: [modelConfig(), event('plan_item', { thought: 'MODEL',
      tool_call_info: { name: '', ...fields } }), final(), done()] });
    const result = await r.run();
    assert.equal(result.response, 'MODEL_OK');
    assert.equal(result.finish_reason, 'stop');
    assert.ok(!r.calls.some((c) => c.method === 'stop_chat'));
  }
});

test('empty tool name rejects malformed tracking IDs and any executable parameters or result', async () => {
  const base = { name: '', id: '', params: null, result: {} };
  for (const fields of [{ id: 0 }, { id: 'x'.repeat(257) }, { id: 'bad\ntracking-id' },
    { params: { command: 'private-target-secret' } },
    { params: [] }, { params: '' }, { result: { status: 'running' } }, { result: [] },
    { result: '' }, { result: null }, { result: undefined }, { name: ' ' }, { name: undefined }]) {
    const r = runtime({ events: [modelConfig(), event('plan_item', { thought: 'MODEL',
      tool_call_info: { ...base, ...fields } }), final(), done()] });
    const result = await r.run();
    assert.equal(result.error.code, 'tool_not_allowed');
    assert.equal(r.stats().stopResolved, true);
    assert.ok(!JSON.stringify(result).includes('private-target-secret'));
  }
});

test('empty placeholder allowance is limited to the observed plan_item event', async () => {
  const r = runtime({ events: [modelConfig(), event('tool_call', {
    tool_call_info: { name: '', id: '', params: null, result: {} } }), final(), done()] });
  assert.equal((await r.run()).error.code, 'tool_not_allowed');
  assert.equal(r.stats().stopResolved, true);
});

test('timeout waits for native stop acknowledgement before returning', async () => {
  const r = runtime({ events: [], hang: true, stopDelay: 25 });
  const started = Date.now();
  const result = await r.run({ timeoutMs: 10 });
  assert.equal(result.error.code, 'timeout');
  assert.ok(Date.now() - started >= 25);
  assert.equal(r.stats().stopResolved, true);
  const stop = r.calls.find((c) => c.method === 'stop_chat');
  const chat = r.calls.find((c) => c.method === 'chat');
  assert.deepEqual(stop.data, { session_id: 'fixture-session', user_message_id: chat.data.message_id });
  assert.deepEqual(stop.context, { project_id: 'fixture-project', chat_session_id: 'fixture-session' });
});

test('output cap requests stop without returning an apparently successful partial response', async () => {
  const r = runtime({ events: [event('plan_item', { thought: '123456' }), done()] });
  const result = await r.run({ maxChars: 5 });
  assert.equal(result.error.code, 'output_limit');
  assert.ok(!('response' in result));
  assert.equal(r.stats().stopResolved, true);
});

test('event count and event-size caps stop the upstream', async () => {
  for (const events of [Array.from({ length: 4097 }, () => event('heartbeat')),
    [event('unknown', { unused: '字'.repeat(100000) })]]) {
    const r = runtime({ events });
    assert.equal((await r.run()).error.code, 'event_limit');
    assert.equal(r.stats().stopResolved, true);
  }
});

test('done is insufficient without onComplete and completion is insufficient without done', async () => {
  const missingDone = runtime({ events: [final()] });
  assert.equal((await missingDone.run()).error.code, 'incomplete_response');
  const missingComplete = runtime({ events: [final(), done()], hang: true });
  assert.equal((await missingComplete.run({ timeoutMs: 10 })).error.code, 'timeout');
  assert.equal(missingComplete.stats().stopResolved, true);
});

test('incomplete status and no valid text cannot become success', async () => {
  for (const [events, code] of [[[final(), event('done', { status: 'cancelled' })], 'incomplete_response'],
    [[done()], 'empty_response'], [[modelConfig(), event('plan_item', { id: 'same-plan', thought: 'intermediate' }),
      event('plan_item', { id: 'same-plan', thought: '',
        tool_call_info: { name: 'finish', params: { summary: '' } } }), done()], 'empty_response']]) {
    const r = runtime({ events });
    assert.equal((await r.run()).error.code, code);
    assert.equal(r.stats().stopResolved, true);
  }
});

test('callback errors, cancellation, subscribe errors and dispatch errors are sanitized and stopped', async () => {
  for (const options of [{ events: [], onError: true }, { events: [], onCancel: true },
    { subscribeThrows: true }, { streamThrows: true }]) {
    const r = runtime(options);
    const result = await r.run();
    assert.ok(result.error);
    assert.equal(r.stats().stopResolved, true);
    assert.ok(!JSON.stringify(result).includes('private-target-secret'));
  }
});

test('stop rejection or nonzero envelope never claims acknowledged termination', async () => {
  for (const options of [{ stopThrows: true }, { stopResponse: { code: 1, message: 'private-target-secret' } }]) {
    const r = runtime({ ...options, events: [], onError: true });
    const result = await r.run();
    assert.equal(result.error.code, 'stop_failed');
    assert.ok(!JSON.stringify(result).includes('private-target-secret'));
  }
});

test('numeric token strings map safely; invalid, negative and unsafe values are not forwarded', async () => {
  const r = runtime({ events: [modelConfig(), final(), event('token_usage', { input: '-1', output: '9007199254740992', token: 'private-target-secret' }), done()] });
  assert.deepEqual((await r.run()).usage, {});
});

test('native catalog, project and session errors stay sanitized and do not start a chat', async () => {
  for (const options of [{ catalogThrows: true }, { catalogResponse: { code: 9, message: 'private-target-secret' } },
    { projectResponse: { code: 0, data: { code: 9, message: 'private-target-secret' } } },
    { sessionResponse: { code: 0, data: {} } }]) {
    const r = runtime(options);
    const result = await r.run();
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes('private-target-secret'));
    assert.ok(!r.calls.some((c) => c.method === 'chat'));
  }
});

test('input and module URL validation occurs before runtime access', async () => {
  let resolves = 0;
  const deps = { resolveClient: () => { resolves++; throw new Error('private-target-secret'); } };
  for (const change of [{ operation: 'execute' }, { uid: '../bad' }, { prompt: '' }, { maxChars: 0 },
    { timeoutMs: 9999999 }, { model: 'glm-5.3/alias' }, { __test: true, operation: 'invalid' }]) {
    assert.equal((await performTraeOperation({ ...input, ...change }, moduleUrl, deps)).error.code, 'invalid_input');
  }
  for (const url of ['https://example.invalid/workbench.desktop.main.js', 'file:///fixture/other.js', moduleUrl + '?cache=1']) {
    assert.equal((await performTraeOperation(input, url, deps)).error.code, 'invalid_input');
  }
  assert.equal(resolves, 0);
});

test('function remains self-contained after toString reconstruction in another realm', async () => {
  const injected = runInNewContext('(' + performTraeOperation.toString() + ')',
    { URL, TextEncoder, setTimeout, clearTimeout, crypto: webcrypto });
  const r = runtime();
  const result = await injected(input, moduleUrl, r.deps);
  assert.equal(result.response, 'MODEL_OK');
  assert.equal(result.upstreamModel, modelId + '__dev');
});
