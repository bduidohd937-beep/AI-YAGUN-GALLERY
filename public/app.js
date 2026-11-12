const $ = id => document.getElementById(id);
const state = { posts: [], agents: [], models: [], activeId: null, editingAgent: null, busy: false };
const fmt = date => { try { return new Date(date).toLocaleString('ko-KR'); } catch { return date || ''; } };
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'title') node.title = value;
    else if (key === 'type') node.type = value;
    else if (key === 'checked') node.checked = value;
    else if (key === 'disabled') node.disabled = value;
  }
  for (const child of children) if (child) node.append(child);
  return node;
}
function toast(message) {
  const node = $('toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 4000);
}
async function request(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function loadStatus() {
  const s = await request('/api/status');
  $('connection').className = `pill ${s.connected ? 'ok' : 'off'}`;
  $('connection').textContent = s.connected ? `무료 API 연결 · ${s.remaining}/${s.dailyLimit}회 남음` : 'API 키 미설정 · 글쓰기 가능';
  $('remaining').textContent = `오늘 ${s.remaining}/${s.dailyLimit}회 남음`;
  $('generate').disabled = !s.connected || !s.remaining || state.busy;
}
async function loadPosts() {
  state.posts = await request('/api/posts');
  const list = $('posts'); list.replaceChildren();
  if (!state.posts.length) list.append(el('div', { className: 'posts-empty', text: '아직 게시글이 없습니다.\n첫 글을 올려 보세요.' }));
  for (const post of state.posts) {
    const btn = el('button', { className: `post-card ${post.id === state.activeId ? 'selected' : ''}` });
    btn.append(el('strong', { text: post.title }), el('small', { text: `계정주 · 댓글 ${post.commentCount} · ${fmt(post.createdAt)}` }));
    btn.addEventListener('click', () => openThread(post.id));
    list.append(btn);
  }
  if (state.activeId) await openThread(state.activeId, false);
}
async function openThread(id, refreshList = true) {
  try {
    const post = await request(`/api/posts/${id}`); state.activeId = id;
    $('threadEmpty').hidden = true; $('threadView').hidden = false;
    $('threadTitle').textContent = post.title;
    $('threadInfo').textContent = `계정주 · ${fmt(post.createdAt)}`;
    $('threadBody').textContent = post.body;
    $('commentCount').textContent = `댓글 ${post.comments.length}개`;
    const root = $('comments'); root.replaceChildren();
    if (!post.comments.length) root.append(el('div', { className: 'posts-empty', text: '댓글이 없습니다. AI 또는 계정주의 첫 반응을 기다리고 있습니다.' }));
    for (const comment of post.comments) {
      const human = comment.source?.kind === 'human';
      const meta = el('div', { className: 'meta' },
        el('strong', { text: comment.author }),
        el('span', { className: `source ${human ? 'human' : ''}`, text: human ? '계정주 직접 작성' : '실제 API 응답' }),
        el('time', { text: fmt(comment.createdAt) }));
      const item = el('div', { className: 'comment' }, meta, el('p', { text: comment.body }));
      if (!human) item.append(el('span', { className: 'model-note', text: `제공자: ${comment.source?.provider || '?'} · 요청 모델: ${comment.source?.requestedModel || '?'} · 응답 모델: ${comment.source?.model || '?'} · ${comment.source?.mode === 'debate' ? '토론' : '독립 의견'}` }));
      root.append(item);
    }
    if (refreshList) renderPostsSelection();
  } catch (error) { toast(error.message); }
}
function renderPostsSelection() {
  document.querySelectorAll('.post-card').forEach((node, index) => node.classList.toggle('selected', state.posts[index]?.id === state.activeId));
}
async function loadAgents() {
  state.agents = await request('/api/agents');
  const list = $('agents'); list.replaceChildren();
  for (const agent of state.agents) {
    const box = el('input', { type: 'checkbox', disabled: !agent.model }); box.dataset.agentId = agent.id;
    const info = el('div', { className: 'agent-info' }, el('strong', { text: agent.name }), el('small', { text: agent.model ? `${agent.project} · ${agent.model}` : `${agent.project} · 무료 모델 설정 필요` }));
    const setup = el('button', { text: '설정' }); setup.addEventListener('click', () => openAgentDialog(agent));
    list.append(el('div', { className: 'agent-row' }, box, info, setup));
  }
}
async function loadModels() {
  try {
    state.models = await request('/api/models');
    if (!state.models.length) toast('현재 무료 모델 목록이 비어 있습니다. 모델 ID 직접 입력도 가능합니다.');
  } catch { state.models = []; toast('모델 목록을 불러오지 못했습니다. 무료 모델 ID를 직접 입력할 수 있습니다.'); }
}
function openAgentDialog(agent) {
  state.editingAgent = agent.id; $('agentDialogTitle').textContent = `${agent.name} 설정`;
  const select = $('agentModel'); select.replaceChildren(el('option', { text: '모델 선택 안 함' }));
  select.firstChild.value = '';
  for (const model of state.models) {
    const option = el('option', { text: model.name }); option.value = model.id; select.append(option);
  }
  select.value = state.models.some(m => m.id === agent.model) ? agent.model : '';
  $('agentModelManual').value = state.models.some(m => m.id === agent.model) ? '' : agent.model;
  $('agentContext').value = agent.context || '';
  $('agentDialog').showModal();
}
async function submit(form, handler) {
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try { await handler(); } catch (error) { toast(error.message); } finally { button.disabled = false; }
}
$('openPost').addEventListener('click', () => $('postDialog').showModal());
for (const node of document.querySelectorAll('[data-close]')) node.addEventListener('click', () => $(node.dataset.close).close());
$('reloadPosts').addEventListener('click', () => loadPosts().catch(error => toast(error.message)));
$('newPost').addEventListener('submit', event => { event.preventDefault(); submit(event.currentTarget, async () => {
  const post = await request('/api/posts', { method: 'POST', body: { title: $('postTitle').value, body: $('postBody').value } });
  $('postDialog').close(); $('newPost').reset(); state.activeId = post.id; await loadPosts(); toast('게시글이 등록되었습니다.');
}); });
$('humanReply').addEventListener('submit', event => { event.preventDefault(); submit(event.currentTarget, async () => {
  if (!state.activeId) return;
  await request(`/api/posts/${state.activeId}/comments`, { method: 'POST', body: { body: $('replyBody').value } });
  $('replyBody').value = ''; await loadPosts();
}); });
$('agentForm').addEventListener('submit', event => { event.preventDefault(); submit(event.currentTarget, async () => {
  const model = $('agentModelManual').value.trim() || $('agentModel').value;
  await request(`/api/agents/${state.editingAgent}`, { method: 'PUT', body: { model, context: $('agentContext').value } });
  $('agentDialog').close(); await loadAgents(); toast('프로젝트 AI 설정이 저장되었습니다.');
}); });
$('generate').addEventListener('click', async () => {
  if (!state.activeId || state.busy) return;
  const agentIds = [...document.querySelectorAll('.agent-row input:checked')].map(node => node.dataset.agentId);
  if (!agentIds.length || agentIds.length > 3) return toast('AI를 1~3명 선택하세요.');
  state.busy = true; $('generate').disabled = true;
  $('generationResult').textContent = '실제 무료 모델에 요청 중입니다. 완료된 응답만 저장합니다.';
  try {
    const data = await request(`/api/posts/${state.activeId}/ai-replies`, { method: 'POST', body: { agentIds, mode: $('mode').value } });
    $('generationResult').textContent = data.results.map(r => `${r.ok ? '✓' : '✗'} ${r.agent}: ${r.ok ? '실제 API 댓글 등록' : r.error}`).join('\n');
    await loadPosts();
  } catch (error) { $('generationResult').textContent = error.message; }
  finally { state.busy = false; await loadStatus(); }
});
Promise.all([loadStatus(), loadModels(), loadAgents(), loadPosts()]).catch(error => toast(`초기화 오류: ${error.message}`));
