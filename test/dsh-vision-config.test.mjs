import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modelSupportsImage, dshModelEntry, modelsForAgents, CLIENTS, PROVIDER_ID } from '../src/agents.mjs';

test('explicit true capability aliases and validated input arrays propagate', () => {
  const sources = ['vision', 'supportsVision', 'supports_vision', 'supports_images', 'supportsImages', 'multimodal'].map(key => ({ [key]: true }));
  sources.push({ capabilities: { vision: true } }, { abilities: { vision: true } },
    { input: ['text', 'image'] }, { input_modalities: ['text', 'image'] },
    { modalities: { input: ['text', 'image'] } }, { architecture: { input_modalities: ['text', 'image'] } });
  for (const source of sources) {
    const original = { id: 'arbitrary-id', ...source };
    const before = JSON.stringify(original);
    assert.equal(modelSupportsImage(original), true);
    const entry = dshModelEntry(modelsForAgents([original])[0]);
    assert.deepEqual(entry.input, ['text', 'image']);
    assert.equal(entry.supportsVision, true);
    assert.equal(JSON.stringify(original), before);
  }
});

test('unknown, malformed and truthy non-booleans cannot advertise images by model name', () => {
  for (const source of [{}, { supports_vision: 'true' }, { vision: 1 }, { multimodal: {} },
    { input: 'text,image' }, { input: ['image', null] }, { input: ['image', 'unknown'] },
    { input: [] }, { input: ['IMAGE'] }, { input: ['text'] }, { output_modalities: ['image'] },
    { input: ['text', , 'image'] }]) {
    const entry = dshModelEntry({ id: 'trae/deepseek-v4.1-flash', ...source });
    assert.deepEqual(entry.input, ['text']);
    assert.equal(entry.supportsVision, undefined);
  }
});

test('explicit false and text-only authoritative arrays conservatively override true', () => {
  for (const negative of [{ vision: false }, { capabilities: { vision: false } }, { abilities: { vision: false } },
    { input_modalities: ['text'] }, { modalities: { input: ['text'] } },
    { architecture: { input_modalities: ['text'] } }, { disabledMultimodal: true }]) {
    const input = { id: 'vision-name', supports_vision: true, input: ['text', 'image'], ...negative };
    assert.deepEqual(dshModelEntry(input).input, ['text']);
    assert.deepEqual(dshModelEntry(modelsForAgents([input])[0]).input, ['text']);
  }
});

test('catalog to DSH preserves existing model fields, provider settings and other client output', () => {
  const home = mkdtempSync(fileURLToPath(new URL('../analysis/test-tmp/dsh-vision-', import.meta.url)));
  try {
    const models = modelsForAgents([{ id: 'image-model', input_modalities: ['text', 'image'], contextWindow: 123456,
      maxOutput: 4567, reasoningEfforts: ['low', 'high'] }, { id: 'text-model' }]);
    const ctx = { models, apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:9999', baseUrlV1: 'http://127.0.0.1:9999/v1' };
    const paths = CLIENTS.dsh.files(home);
    const outputs = CLIENTS.dsh.apply(paths, ctx);
    const line = outputs[paths.settings].split('\n').find(line => line.trim().startsWith(PROVIDER_ID + ':'));
    const provider = JSON.parse(line.slice(line.indexOf(':') + 1));
    assert.deepEqual(provider.models[0], { id: 'image-model', input: ['text', 'image'], contextWindow: 123456,
      maxTokens: 4567, reasoningEfforts: { low: 'low', high: 'high' }, supportsVision: true });
    assert.deepEqual(provider.models[1], { id: 'text-model', input: ['text'] });
    assert.equal(provider.api, 'openai-completions');
    assert.deepEqual(provider.compat, { thinkingFormat: 'openai', supportsReasoningEffort: true });
    const crushPaths = CLIENTS.crush.files(home);
    const crush = JSON.parse(CLIENTS.crush.apply(crushPaths, ctx)[crushPaths.config]);
    assert.ok(crush.providers[PROVIDER_ID].models.every(entry => !Object.hasOwn(entry, 'input')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
