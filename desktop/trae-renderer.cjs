'use strict';

// Keep every renderer dependency inside this function: callers inject its
// toString() into the already-running TRAE renderer. deps is an in-process test
// seam only; production callers pass exactly input and the verified loaded URL.
async function performTraeOperation(input, moduleUrl, deps) {
  const messages = {
    invalid_input: 'TRAE 请求参数无效。', native_client_unavailable: '无法访问当前 TRAE 客户端。',
    wrong_current_account: '当前 TRAE 登录账号与所选账号不一致。',
    catalog_unavailable: 'TRAE 未返回可用的原生模型目录。', model_unavailable: '所选模型不在当前原生目录中。',
    native_request_failed: 'TRAE 原生请求失败。', invalid_native_response: 'TRAE 返回了无效响应。',
    timeout: 'TRAE 请求超时，已请求停止。', output_limit: 'TRAE 输出达到本地限制，已请求停止。',
    event_limit: 'TRAE 事件达到本地限制，已请求停止。', tool_not_allowed: '纯文本请求出现工具调用，已请求停止。',
    upstream_model_mismatch: 'TRAE 返回的模型配置与所选模型不一致。',
    upstream_model_unconfirmed: 'TRAE 未确认所选模型的实际配置。',
    incomplete_response: 'TRAE 响应未完整结束。', empty_response: 'TRAE 未返回有效文本。',
    upstream_error: 'TRAE 对话失败，已请求停止。', stop_failed: 'TRAE 停止请求未确认完成。'
  };
  const failure = (code) => Object.assign(new Error(messages[code]), { safeCode: code });
  const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  let client, sandbox, stream, subscription, projectId, sessionId, messageId;
  let chatStarted = false;
  let deadline = 0;
  const maxEvents = 4096;
  const maxEventBytes = 256 * 1024;
  const maxTotalEventBytes = 4 * 1024 * 1024;

  async function limited(promise, timeout, code = 'timeout') {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure(code)), Math.max(1, timeout));
      })]);
    } finally { clearTimeout(timer); }
  }
  const remaining = () => Math.max(1, deadline - Date.now());
  function unwrap(response) {
    if (!isObject(response)) throw failure('invalid_native_response');
    let value = response;
    for (let n = 0; n < 2; n++) {
      if ('code' in value && value.code !== 0 && value.code !== '0') throw failure('native_request_failed');
      if (!isObject(value.data)) break;
      value = value.data;
    }
    if ('code' in value && value.code !== 0 && value.code !== '0') throw failure('native_request_failed');
    return value;
  }
  function cleanPayload(payload) {
    if (!isObject(payload)) throw failure('invalid_native_response');
    return { ...payload, client_info: { ...(isObject(payload.client_info) ? payload.client_info : {}),
      workspace_folder: '', workspace_folders: [], git_repos: [], local_git_repos: [],
      git_metadata_dirs: [], security_rules: [], workspace_id: '', enable_browser_tools: false,
      permission_profile_id: 'manual_approval' } };
  }
  function catalogModels(response) {
    const value = unwrap(response);
    if (!Array.isArray(value.list) || value.list.length > 128) throw failure('catalog_unavailable');
    const result = [], seen = new Set();
    for (const group of value.list) {
      if (!isObject(group) || group.function !== 'chat_v3' || !Array.isArray(group.models)) continue;
      if (group.models.length > 4096) throw failure('catalog_unavailable');
      for (const model of group.models) {
        if (!isObject(model) || typeof model.name !== 'string' || !modelPattern.test(model.name)
            || model.name.toLowerCase().startsWith('custom_') || seen.has(model.name)) continue;
        if (['is_preset', 'status', 'selectable'].some((key) => model[key] !== true)) continue;
        if (['ak', 'sk', 'base_url', 'custom_model_id', 'custom_model_type', 'provider', 'auth_type']
          .some((key) => model[key] != null && model[key] !== '' && model[key] !== false && model[key] !== 0)) continue;
        if (['client_connect', 'is_custom_base_url'].some((key) => model[key] != null && model[key] !== false)) continue;
        if (model.config_source != null && model.config_source !== 1) continue;
        const name = model.display_name == null || model.display_name === '' ? model.name : model.display_name;
        if (typeof name !== 'string' || !name.length || name.length > 160 || name !== name.trim()
            || /[\p{C}]/u.test(name)) continue;
        result.push({ upstreamId: model.name, name, route: 'native_client' });
        seen.add(model.name);
      }
    }
    if (!result.length) throw failure('catalog_unavailable');
    return result;
  }
  async function request(service, method, data, context = {}) {
    const value = await limited(sandbox.request({ service, method, data, context, timeout: remaining() }), remaining());
    if (Date.now() >= deadline) throw failure('timeout');
    return value;
  }
  function numericToken(value) {
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  async function stopChat() {
    unwrap(await limited(sandbox.request({ service: 'chat', method: 'stop_chat',
      data: { session_id: sessionId, user_message_id: messageId },
      context: { project_id: projectId, chat_session_id: sessionId }, timeout: 10000 }), 10000, 'stop_failed'));
  }
  function cancelLocal() {
    // Native stop is always awaited first on failure. Local unsubscription alone
    // is not considered server-side cancellation.
    try {
      const pending = subscription?.unsubscribe?.();
      pending?.catch?.(() => {});
    } catch { /* no target error disclosure */ }
    try {
      const pending = stream?.cancel?.();
      pending?.catch?.(() => {});
    } catch { /* no target error disclosure */ }
  }

  try {
    if (!isObject(input) || !['catalog', 'chat'].includes(input.operation)
        || typeof input.uid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(input.uid)
        || typeof moduleUrl !== 'string' || moduleUrl.length > 4096) throw failure('invalid_input');
    const url = new URL(moduleUrl);
    if (!['file:', 'vscode-file:'].includes(url.protocol) || url.search || url.hash
        || !/\/workbench\.desktop\.main(?:\.solo-lite-slim)?\.js$/.test(url.pathname)) throw failure('invalid_input');
    const timeoutMs = input.timeoutMs == null ? 120000 : input.timeoutMs;
    const maxChars = input.maxChars == null ? 32768 : input.maxChars;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000
        || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 65536) throw failure('invalid_input');
    if (input.operation === 'chat' && (typeof input.model !== 'string' || !modelPattern.test(input.model)
        || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 65536
        || input.prompt.includes('\0'))) throw failure('invalid_input');
    deadline = Date.now() + timeoutMs;
    try {
      if (deps && typeof deps.resolveClient === 'function') {
        client = await limited(Promise.resolve(deps.resolveClient(moduleUrl)), remaining());
      } else {
        const wb = await limited(import(moduleUrl), remaining());
        const sc = wb.icubeStore.serviceCollection;
        const inst = sc.get(wb.createDecorator('instantiationService'));
        const conn = inst.invokeFunction((accessor) => accessor.get(wb.createDecorator('IICubeAiChatConnectionService')));
        client = await limited(conn.getDefaultClient(), remaining());
      }
    } catch (error) {
      if (error?.safeCode === 'timeout') throw error;
      throw failure('native_client_unavailable');
    }
    if (!client || typeof client.createUserInfo !== 'function' || typeof client.request !== 'function'
        || typeof client.convertReqToRustPayload !== 'function') throw failure('native_client_unavailable');
    const current = await limited(Promise.resolve(client.createUserInfo()), remaining());
    if (!current || current.user_id !== input.uid) throw failure('wrong_current_account');
    sandbox = Object.create(client);
    sandbox.convertReqToRustPayload = function (...args) {
      const payload = client.convertReqToRustPayload.apply(client, args);
      return payload && typeof payload.then === 'function' ? payload.then(cleanPayload) : cleanPayload(payload);
    };
    const models = catalogModels(await request('model', 'model_list_by_function',
      { functions: ['chat_v3'], force_refresh: true }));
    if (input.operation === 'catalog') return { models, source: 'native_client', fetchedAt: Date.now() / 1000 };
    const model = models.find((candidate) => candidate.upstreamId === input.model);
    if (!model) throw failure('model_unavailable');
    if (typeof sandbox.requestForStream !== 'function') throw failure('native_client_unavailable');
    const project = unwrap(await request('lite', 'get_or_create_project_v2', { project_kind: 'empty' }));
    projectId = project.project_id;
    if (typeof projectId !== 'string' || !projectId || projectId.length > 256) throw failure('invalid_native_response');
    const session = unwrap(await request('chat', 'create_session', { project_id: projectId, session_type: 'side_chat' },
      { project_id: projectId }));
    sessionId = session.session?.session_id;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw failure('invalid_native_response');
    messageId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const data = { agent_type: 'chat', session_id: sessionId, message_id: messageId, mention_context: {},
      model_name: model.upstreamId,
      custom_model: { provider: '', config_name: model.upstreamId, display_model_name: model.name,
        multimodal: false, ak: '', sk: '', base_url: '', auth_type: 0, use_remote_service: true,
        is_preset: true, config_source: 1 }, terminal_context: [],
      message_content: [{ type: 'text', text_content: '仅返回纯文本，不使用任何工具，不读取或修改文件，不执行命令。\n\n' + input.prompt }],
      code_selections: [], scene_location: 2, parsed_query: [], multi_media: [], workspace_folders: [],
      is_workspace_folder_changed: false, active_text_editor: null, asr_times: 0 };
    chatStarted = true;
    stream = await limited(Promise.resolve(sandbox.requestForStream({ service: 'chat', method: 'chat', data,
      context: { project_id: projectId, chat_session_id: sessionId }, timeout: remaining() })), remaining());
    if (!stream || typeof stream.subscribe !== 'function') throw failure('invalid_native_response');
    const result = await new Promise((resolve, reject) => {
      let settled = false, completed = false, modelConfirmed = false;
      let thought = '', reasoning = '', summary = null, upstreamModel = null;
      let count = 0, eventBytes = 0, usage = {};
      const planItems = new Map();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) return reject(error);
        const response = summary === null ? thought : summary;
        if (!completed) return reject(failure('incomplete_response'));
        if (!response.trim()) return reject(failure('empty_response'));
        if (!modelConfirmed) return reject(failure('upstream_model_unconfirmed'));
        resolve({ response, reasoning_content: reasoning, usage, finish_reason: 'stop',
          upstreamModel, model: model.upstreamId });
      };
      const timer = setTimeout(() => finish(failure('timeout')), remaining());
      const onMessage = (event) => {
        if (settled) return;
        try {
          if (!isObject(event) || !isObject(event.payload)) throw failure('invalid_native_response');
          const encoded = JSON.stringify(event);
          const bytes = new TextEncoder().encode(encoded).byteLength;
          if (++count > maxEvents || bytes > maxEventBytes
              || (eventBytes += bytes) > maxTotalEventBytes) throw failure('event_limit');
          const kind = event.event;
          const payload = event.payload;
          const tool = payload.tool_call_info;
          if (tool != null) {
            // Official PlanItemParser normalizes null params to {}; native UI
            // only enqueues/marks a tool when tool_call_info.name is truthy.
            // A nonempty bounded ID is tracking metadata, not a tool name
            // (confirmed in empty-tool-proof.json). No executable params or
            // nonempty result are permitted in this placeholder allowance.
            const emptyObject = (value) => value == null || (isObject(value) && Object.keys(value).length === 0);
            const placeholder = kind === 'plan_item' && isObject(tool) && tool.name === ''
              && (tool.id == null || (typeof tool.id === 'string' && tool.id.length <= 256 && !/[\p{C}]/u.test(tool.id)))
              && emptyObject(tool.params) && isObject(tool.result) && Object.keys(tool.result).length === 0;
            if (!isObject(tool) || (!placeholder && tool.name !== 'finish')) throw failure('tool_not_allowed');
            if (tool.name === 'finish' && isObject(tool.params) && 'summary' in tool.params) {
              if (typeof tool.params.summary !== 'string') throw failure('invalid_native_response');
              // Official IPlanItemParser only lets a truthy summary replace
              // thought. Empty summary falls back to the latest item snapshots.
              summary = tool.params.summary || null;
            }
          }
          if (kind === 'model_config') {
            if (payload.config_name == null || payload.model_name == null) throw failure('upstream_model_unconfirmed');
            if (payload.config_name !== model.upstreamId) throw failure('upstream_model_mismatch');
            if (typeof payload.model_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(payload.model_name)) {
              throw failure('invalid_native_response');
            }
            upstreamModel = payload.model_name;
            modelConfirmed = true;
          } else if (kind === 'plan_item') {
            // Official StreamDataWriter.updatePlanItem uses r ?? previousThought
            // and n ?? previousReasoning: each item field is a snapshot, not a
            // token delta. Preserve first-seen item order and unrelated items.
            if (payload.id != null && (typeof payload.id !== 'string' || payload.id.length > 256
                || /[\p{C}]/u.test(payload.id))) throw failure('invalid_native_response');
            if ((payload.thought != null && typeof payload.thought !== 'string')
                || (payload.reasoning_content != null && typeof payload.reasoning_content !== 'string')) {
              throw failure('invalid_native_response');
            }
            const id = payload.id ?? '';
            const previous = planItems.get(id) || { thought: '', reasoning: '' };
            planItems.set(id, {
              thought: payload.thought ?? previous.thought,
              reasoning: payload.reasoning_content ?? previous.reasoning
            });
            thought = Array.from(planItems.values(), (item) => item.thought).join('');
            reasoning = Array.from(planItems.values(), (item) => item.reasoning).join('');
          } else if (kind === 'token_usage') {
            const inputTokens = numericToken(payload.input), outputTokens = numericToken(payload.output);
            if (inputTokens !== null) usage.prompt_tokens = inputTokens;
            if (outputTokens !== null) usage.completion_tokens = outputTokens;
            if (inputTokens !== null && outputTokens !== null && Number.isSafeInteger(inputTokens + outputTokens)) {
              usage.total_tokens = inputTokens + outputTokens;
            }
          } else if (kind === 'done') {
            if (payload.status !== 'completed') throw failure('incomplete_response');
            completed = true;
          } else if (kind === 'error') throw failure('upstream_error');
          if (thought.length > maxChars || reasoning.length > maxChars
              || (summary !== null && summary.length > maxChars)
              || (summary === null ? thought.length : summary.length) + reasoning.length > maxChars) {
            throw failure('output_limit');
          }
        } catch (error) { finish(error?.safeCode ? error : failure('invalid_native_response')); }
      };
      try {
        subscription = stream.subscribe({ onMessage, onError: () => finish(failure('upstream_error')),
          onComplete: () => finish(), onCancel: () => finish(failure('incomplete_response')) });
      } catch { finish(failure('upstream_error')); }
    });
    cancelLocal();
    return result;
  } catch (error) {
    let code = Object.hasOwn(messages, error?.safeCode) ? error.safeCode : 'native_request_failed';
    if (chatStarted && sandbox && sessionId && messageId) {
      try { await stopChat(); } catch { code = 'stop_failed'; }
      cancelLocal();
    }
    return { error: { code, message: messages[code] } };
  }
}

module.exports = { performTraeOperation };
