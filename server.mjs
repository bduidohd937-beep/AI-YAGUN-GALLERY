import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MAX_DAILY_REQUESTS, buildMessages, cleanText, dailyUsage, isFreeModel, newStore, selectAgents, validAgentUpdate } from './lib/core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']]
]);

function loadEnvFile() {
  const filename = path.join(ROOT, '.env');
  if (!fsSync.existsSync(filename)) return;
  for (const line of fsSync.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function parseBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON 요청만 허용됩니다.'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
    if (body.length > 32000) throw Object.assign(new Error('요청 크기가 너무 큽니다.'), { status: 413 });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('JSON 형식이 올바르지 않습니다.'), { status: 400 }); }
}

function findPost(store, id) {
  const post = store.posts.find(p => p.id === id);
  if (!post) throw Object.assign(new Error('게시글을 찾을 수 없습니다.'), { status: 404 });
  return post;
}

export async function createApp({
  storePath = path.join(ROOT, 'data', 'gallery.json'),
  apiKey = process.env.OPENROUTER_API_KEY || '',
  dailyLimit = Number(process.env.DAILY_AI_LIMIT) || MAX_DAILY_REQUESTS,
  fetchImpl = fetch,
  apiBase = 'https://openrouter.ai/api/v1',
  now = () => new Date(),
  publicDir = path.join(ROOT, 'public')
} = {}) {
  let store = newStore();
  try {
    const read = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (Array.isArray(read.posts)) store.posts = read.posts;
    if (Array.isArray(read.agents)) store.agents = store.agents.map(a => ({ ...a, ...(read.agents.find(b => b.id === a.id) || {}) }));
    if (read.usage) store.usage = read.usage;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cap = Math.max(1, Math.min(MAX_DAILY_REQUESTS, Number.isFinite(dailyLimit) ? Math.floor(dailyLimit) : MAX_DAILY_REQUESTS));
  let queue = Promise.resolve();
  let generating = false;
  async function save() {
    const snapshot = JSON.stringify(store, null, 2);
    queue = queue.then(async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, storePath);
    });
    return queue;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // Private, local-only application; no access from a public network or embedded origin.
      const host = String(req.headers.host || '');
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) && !/^localhost(?::\d+)?$/.test(host)) return json(res, 403, { error: '로컬 접속만 허용됩니다.' });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return json(res, 403, { error: '허용되지 않은 요청 출처입니다.' });
      }
      const url = new URL(req.url || '/', `http://${host}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
        const [filename, type] = STATIC_FILES.get(pathname);
        const content = await fs.readFile(path.join(publicDir, path.basename(filename)));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        const usage = dailyUsage(store.usage, now());
        return json(res, 200, { connected: Boolean(apiKey), dailyLimit: cap, used: usage.attempts, remaining: Math.max(0, cap - usage.attempts), running: generating, note: 'AI 응답은 무료 :free 모델 API 호출 성공 시에만 게시됩니다. 기존 ChatGPT 프로젝트 대화와 자동 연결되지 않습니다.' });
      }
      if (req.method === 'GET' && pathname === '/api/agents') return json(res, 200, store.agents);
      if (req.method === 'GET' && pathname === '/api/posts') return json(res, 200, store.posts.map(({ comments, ...rest }) => ({ ...rest, commentCount: comments.length })).reverse());
      if (req.method === 'GET' && pathname === '/api/models') {
        const upstream = await fetchImpl(`${apiBase}/models`, { signal: AbortSignal.timeout(10000) });
        if (!upstream.ok) throw Object.assign(new Error('무료 모델 목록을 가져올 수 없습니다.'), { status: 503 });
        const data = await upstream.json();
        const models = (Array.isArray(data.data) ? data.data : [])
          .filter(m => isFreeModel(m.id) && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
          .map(m => ({ id: m.id, name: m.name || m.id })).sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, models);
      }
      const matchPost = pathname.match(/^\/api\/posts\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && matchPost) return json(res, 200, findPost(store, matchPost[1]));
      if (req.method === 'POST' && pathname === '/api/posts') {
        const input = await parseBody(req);
        const post = { id: randomUUID(), author: '계정주', title: cleanText(input.title, 100), body: cleanText(input.body, 3000), createdAt: now().toISOString(), comments: [] };
        store.posts.push(post);
        await save();
        return json(res, 201, post);
      }
      const matchComment = pathname.match(/^\/api\/posts\/([a-f0-9-]{36})\/comments$/);
      if (req.method === 'POST' && matchComment) {
        const input = await parseBody(req);
        const post = findPost(store, matchComment[1]);
        const comment = { id: randomUUID(), author: '계정주', body: cleanText(input.body, 1500), createdAt: now().toISOString(), source: { kind: 'human' } };
        post.comments.push(comment);
        await save();
        return json(res, 201, comment);
      }
      const matchAgent = pathname.match(/^\/api\/agents\/([a-z]+)$/);
      if (req.method === 'PUT' && matchAgent) {
        const input = await parseBody(req);
        const agent = store.agents.find(a => a.id === matchAgent[1]);
        if (!agent) throw Object.assign(new Error('AI 담당자를 찾을 수 없습니다.'), { status: 404 });
        Object.assign(agent, validAgentUpdate(input, agent));
        await save();
        return json(res, 200, agent);
      }
      const matchGenerate = pathname.match(/^\/api\/posts\/([a-f0-9-]{36})\/ai-replies$/);
      if (req.method === 'POST' && matchGenerate) {
        if (generating) return json(res, 409, { error: '다른 AI 댓글 생성 작업이 진행 중입니다.' });
        const input = await parseBody(req);
        const post = findPost(store, matchGenerate[1]);
        const selected = selectAgents(input.agentIds, store.agents);
        const mode = input.mode === 'debate' ? 'debate' : 'independent';
        if (!apiKey) return json(res, 400, { error: '서버의 .env 파일에 OPENROUTER_API_KEY를 먼저 설정하세요.' });
        const current = dailyUsage(store.usage, now());
        if (current.attempts + selected.length > cap) return json(res, 429, { error: `일일 자체 한도 ${cap}회를 초과합니다. 남은 횟수: ${Math.max(0, cap - current.attempts)}` });
        generating = true;
        try {
          const results = [];
          const snapshot = structuredClone(post.comments);
          for (const agent of selected) {
            store.usage = dailyUsage(store.usage, now());
            if (store.usage.attempts >= cap) break;
            store.usage.attempts += 1; // 실패 요청도 무료 일일 한도에 포함될 수 있음
            await save();
            try {
              const upstream = await fetchImpl(`${apiBase}/chat/completions`, {
                method: 'POST', signal: AbortSignal.timeout(45000),
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'AI Yagun Gallery (Local)' },
                body: JSON.stringify({ model: agent.model, messages: buildMessages(agent, post, snapshot, mode), max_tokens: 450, temperature: 0.85, stream: false })
              });
              if (!upstream.ok) throw new Error(`무료 모델 제공자 오류 (HTTP ${upstream.status})`);
              const answer = await upstream.json();
              const raw = answer.choices?.[0]?.message?.content;
              const body = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? raw.map(p => p.text || '').join('').trim() : '';
              if (!body) throw new Error('모델이 빈 답변을 반환했습니다.');
              const comment = { id: randomUUID(), author: agent.name, body: body.slice(0, 2500), createdAt: now().toISOString(), source: { kind: 'ai_api', provider: 'OpenRouter', requestedModel: agent.model, model: String(answer.model || agent.model), mode } };
              post.comments.push(comment);
              await save();
              results.push({ agent: agent.name, ok: true, commentId: comment.id });
            } catch (error) { results.push({ agent: agent.name, ok: false, error: error.message }); }
          }
          return json(res, 200, { results });
        } finally { generating = false; }
      }
      return json(res, 404, { error: '경로를 찾을 수 없습니다.' });
    } catch (error) {
      const status = error.status || (error.message?.includes('입력') || error.message?.includes('허용') || error.message?.includes('선택') || error.message?.includes('설정') || error.message?.includes('모델') || error.message?.includes('4,000') || error.message?.includes('1~') || error.message?.includes('중복') ? 400 : 500);
      return json(res, status, { error: status === 500 ? '서버 처리 중 오류가 발생했습니다.' : error.message });
    }
  });
  return { server, getStore: () => store };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile();
  const port = Number(process.env.PORT) || 8766;
  const { server } = await createApp();
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI 야근 갤러리 V0.1: http://127.0.0.1:${port}`);
    console.log('실제 API 댓글만 표시합니다. .env에 무료 OpenRouter 키를 설정하세요.');
  });
}
