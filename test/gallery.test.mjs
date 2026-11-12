import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { buildMessages, dailyUsage, isFreeModel, selectAgents } from '../lib/core.mjs';

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-yagun-test-'));
  const { server } = await createApp({ storePath: path.join(directory, 'store.json'), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(route, method = 'GET', body) {
    const res = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  }
  return { api, base, directory, cleanup: async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
}

async function postOne(api) {
  const res = await api('/api/posts', 'POST', { title: '시험 전날', body: '공부가 잘 안 된다' });
  assert.equal(res.status, 201);
  return res.body;
}

test('무료 모델 이외에는 허용하지 않는다', () => {
  assert.equal(isFreeModel('google/gemma-4:free'), true);
  assert.equal(isFreeModel('google/gemma-4'), false);
  assert.equal(isFreeModel('openrouter/free'), false);
  assert.equal(isFreeModel('abc:free?price=1'), false);
});

test('날짜가 바뀌면 로컬 사용량 초기화', () => {
  const usage = dailyUsage({ day: '2026-01-01', attempts: 9 }, new Date('2026-01-02T01:00:00Z'));
  assert.deepEqual(usage, { day: '2026-01-02', attempts: 0 });
});

test('글 작성·사람 댓글·영속 저장', async () => {
  const f = await fixture({ apiKey: '' });
  try {
    const post = await postOne(f.api);
    const comment = await f.api(`/api/posts/${post.id}/comments`, 'POST', { body: '직접 작성' });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.source.kind, 'human');
    const stored = JSON.parse(await readFile(path.join(f.directory, 'store.json'), 'utf8'));
    assert.equal(stored.posts[0].comments[0].body, '직접 작성');
    const status = await f.api('/api/status');
    assert.equal(status.body.connected, false);
    const invoke = await f.api(`/api/posts/${post.id}/ai-replies`, 'POST', { agentIds: ['main'] });
    assert.equal(invoke.status, 400);
  } finally { await f.cleanup(); }
});

test('유료 모델 저장을 차단하고 서로 같은 모델 중복도 막는다', async () => {
  const f = await fixture({ apiKey: 'test-key' });
  try {
    assert.equal((await f.api('/api/agents/main', 'PUT', { model: 'openai/gpt-4o', context: '' })).status, 400);
    assert.equal((await f.api('/api/agents/main', 'PUT', { model: 'some/model:free', context: '참고 자료' })).status, 200);
    assert.equal((await f.api('/api/agents/math', 'PUT', { model: 'some/model:free', context: '' })).status, 200);
    const post = await postOne(f.api);
    const duplicate = await f.api(`/api/posts/${post.id}/ai-replies`, 'POST', { agentIds: ['main', 'math'] });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.error, /서로 다른 모델/);
    const status = await f.api('/api/status');
    assert.equal(status.body.used, 0);
  } finally { await f.cleanup(); }
});

test('실제 API 성공 시에만 AI 댓글로 기록하고 서로 다른 모델을 구분한다', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    const request = JSON.parse(opts.body);
    calls.push({ url, request });
    return { ok: true, json: async () => ({ model: request.model, choices: [{ message: { content: `개별 의견 ${request.model}` } }] }) };
  };
  const f = await fixture({ apiKey: 'test-key', fetchImpl: mockFetch });
  try {
    const post = await postOne(f.api);
    await f.api('/api/agents/main', 'PUT', { model: 'a/alpha:free', context: '문서 A' });
    await f.api('/api/agents/math', 'PUT', { model: 'b/beta:free', context: '문서 B' });
    const result = await f.api(`/api/posts/${post.id}/ai-replies`, 'POST', { agentIds: ['main', 'math'], mode: 'independent' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.results.map(r => r.ok), [true, true]);
    const saved = (await f.api(`/api/posts/${post.id}`)).body;
    assert.equal(saved.comments.length, 2);
    assert.equal(saved.comments[0].source.kind, 'ai_api');
    assert.equal(saved.comments[1].source.requestedModel, 'b/beta:free');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].request.model, 'a/alpha:free');
    assert.equal(calls[1].request.model, 'b/beta:free');
    assert.ok(!calls[1].request.messages[1].content.includes('개별 의견 a/alpha:free'), '독립 호출은 선행 AI의 답변을 참조하지 않는다');
    assert.ok(calls[0].request.messages[0].content.includes('문서 A'));
    assert.equal((await f.api('/api/status')).body.used, 2);
  } finally { await f.cleanup(); }
});

test('실패도 한도에 포함, 가짜 AI 댓글은 쓰지 않음', async () => {
  const f = await fixture({ apiKey: 'test-key', dailyLimit: 1, fetchImpl: async () => ({ ok: false, status: 429 }) });
  try {
    const post = await postOne(f.api);
    await f.api('/api/agents/main', 'PUT', { model: 'a/alpha:free', context: '' });
    const first = await f.api(`/api/posts/${post.id}/ai-replies`, 'POST', { agentIds: ['main'] });
    assert.equal(first.status, 200);
    assert.equal(first.body.results[0].ok, false);
    assert.equal((await f.api(`/api/posts/${post.id}`)).body.comments.length, 0);
    const second = await f.api(`/api/posts/${post.id}/ai-replies`, 'POST', { agentIds: ['main'] });
    assert.equal(second.status, 429);
    assert.equal((await f.api('/api/status')).body.used, 1);
  } finally { await f.cleanup(); }
});

test('무료 모델 목록은 :free 및 가격 0인 항목만 노출한다', async () => {
  const f = await fixture({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
    { id: 'a/alpha:free', name: 'Alpha', pricing: { prompt: '0', completion: '0' } },
    { id: 'b/beta', name: 'Paid', pricing: { prompt: '1', completion: '1' } },
    { id: 'c/false:free', name: 'Fake free', pricing: { prompt: '0', completion: '0.1' } }
  ] }) }) });
  try {
    const models = await f.api('/api/models');
    assert.equal(models.status, 200);
    assert.deepEqual(models.body.map(m => m.id), ['a/alpha:free']);
  } finally { await f.cleanup(); }
});

test('호스트와 오리진 검사', async () => {
  const f = await fixture();
  try {
    const res = await fetch(f.base + '/api/posts', { method: 'POST', headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'a', body: 'b' }) });
    assert.equal(res.status, 403);
    const html = await fetch(f.base + '/');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /AI 야근 갤러리/);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { await f.cleanup(); }
});
