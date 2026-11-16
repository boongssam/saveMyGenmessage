(() => {
  const $ = (id) => document.getElementById(id);
  const state = { kind: '', q: '', person: '', from: '', to: '', files: false, page: 1, selected: null };

  /** Tiny element builder; text is always set via textContent (never innerHTML). */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.replace('/login'); throw new Error('login'); }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || '요청을 처리하지 못했습니다.');
    return body;
  }

  function toast(msg, ms = 3500) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function query(extra = {}) {
    const p = new URLSearchParams();
    const s = { ...state, ...extra };
    if (s.kind) p.set('kind', s.kind);
    if (s.q) p.set('q', s.q);
    if (s.person) p.set('person', s.person);
    if (s.from) p.set('from', s.from);
    if (s.to) p.set('to', s.to);
    if (s.files) p.set('files', '1');
    if (s.page > 1) p.set('page', s.page);
    return p.toString();
  }

  // ---------------------------------------------------------- status

  async function loadStatus() {
    const s = await api('/api/status');
    const parts = [`보관 ${Number(s.total).toLocaleString()}건 (받은 ${s.recv ?? 0} · 보낸 ${s.send ?? 0})`];
    if (s.oldest) parts.push(`${s.oldest.slice(0, 10)} ~ ${s.newest.slice(0, 10)}`);
    if (s.lastRun) {
      const at = new Date(s.lastRun.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      parts.push(s.lastRun.ok ? `마지막 수집 ${at}` : `⚠ 마지막 수집 실패 (${at})`);
    }
    $('status').textContent = parts.join('  ·  ');
    $('status').classList.toggle('warn', !!(s.lastRun && !s.lastRun.ok));
    $('status').title = s.lastRun?.error ?? '';
  }

  // ---------------------------------------------------------- list

  async function loadList() {
    const data = await api('/api/messages?' + query());
    $('exportBtn').href = '/api/export.csv?' + query({ page: 1 });
    $('count').textContent = data.total ? `${data.total.toLocaleString()}건` : '';
    const list = $('list');
    list.replaceChildren();
    if (!data.items.length) {
      list.append(h('li', { class: 'no-result' }, '조건에 맞는 쪽지가 없습니다.'));
    }
    for (const m of data.items) {
      const who = m.kind === 'recv' ? m.sender : `→ ${shortNames(m.recipients)}`;
      const unread = m.kind === 'recv' && !m.read;
      list.append(h('li', {},
        h('button', {
          class: 'msg-item' + (state.selected === m.id ? ' selected' : '') + (unread ? ' unread' : ''),
          'data-id': m.id,
          onclick: () => select(m.id),
        },
        h('div', { class: 'msg-row1' },
          h('span', { class: `badge ${m.kind}` }, m.kind === 'recv' ? '받음' : '보냄'),
          h('span', { class: 'msg-who' }, who || '(알 수 없음)'),
          h('time', { class: 'msg-date' }, m.sent)),
        h('div', { class: 'msg-subject' },
          m.has_files ? h('span', { class: 'clip', title: '첨부 있음', 'aria-label': '첨부 있음' }, '📎') : null,
          m.subject || '(제목 없음)'),
        h('div', { class: 'msg-preview' }, m.preview?.trim() ?? ''),
        m.kind === 'send' && m.reader_total
          ? h('div', { class: 'msg-readers' }, `읽음 ${m.reader_read}/${m.reader_total}`)
          : null)));
    }
    renderPager(data);
  }

  function shortNames(names) {
    if (!names) return '';
    const arr = names.split(',').map((s) => s.trim()).filter(Boolean);
    return arr.length > 3 ? `${arr.slice(0, 3).join(', ')} 외 ${arr.length - 3}명` : arr.join(', ');
  }

  function renderPager({ total, page, pageSize }) {
    const pages = Math.ceil(total / pageSize);
    const nav = $('pager');
    nav.replaceChildren();
    if (pages <= 1) return;
    const go = (p) => () => { state.page = p; loadList(); $('list').scrollTop = 0; };
    nav.append(
      h('button', { class: 'btn btn-ghost', disabled: page <= 1, onclick: go(page - 1) }, '‹ 이전'),
      h('span', {}, `${page} / ${pages}`),
      h('button', { class: 'btn btn-ghost', disabled: page >= pages, onclick: go(page + 1) }, '다음 ›'),
    );
  }

  // ---------------------------------------------------------- detail

  async function select(id) {
    state.selected = id;
    document.querySelectorAll('.msg-item').forEach((el) =>
      el.classList.toggle('selected', Number(el.dataset.id) === id));
    const m = await api(`/api/messages/${id}`);
    const detail = $('detail');

    const meta = h('dl', { class: 'meta' },
      h('dt', {}, '보낸 사람'), h('dd', {}, m.sender || '-'),
      h('dt', {}, '받는 사람'), h('dd', {}, m.recipients || '-'),
      m.cc ? [h('dt', {}, '참조'), h('dd', {}, m.cc)] : null,
      h('dt', {}, '보낸 시각'), h('dd', {}, m.sent || '-'),
      m.kind === 'recv' && m.read ? [h('dt', {}, '읽은 시각'), h('dd', {}, m.read)] : null,
    );

    const files = m.attachments.length
      ? h('div', { class: 'attachments' },
        h('h3', {}, `첨부파일 ${m.attachments.length}개`),
        h('ul', {}, m.attachments.map((a) => h('li', {},
          a.stored_id
            ? h('a', { href: `/api/files/${a.stored_id}`, class: 'file saved' }, a.file_name)
            : h('span', { class: 'file missing', title: '메신저에서 내려받은 적이 없어 보관되지 않았습니다' }, a.file_name),
          a.file_size ? h('span', { class: 'size' }, `${a.file_size} bytes`) : null,
          a.stored_id ? null : h('span', { class: 'tag' }, '미보관')))))
      : null;

    const readers = m.kind === 'send' && m.readers.length
      ? h('details', { class: 'readers' },
        h('summary', {}, `읽음 확인 (${m.readers.filter((r) => r.read).length}/${m.readers.length}명)`),
        h('ul', {}, m.readers.map((r) => h('li', { class: r.read ? 'read' : 'unread' },
          h('span', {}, r.name), h('span', {}, r.read || '안 읽음')))))
      : null;

    const frame = h('iframe', {
      class: 'body-frame',
      title: '쪽지 본문',
      sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
      src: `/api/messages/${id}/body`,
    });
    frame.addEventListener('load', () => {
      try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 24 + 'px'; } catch {}
    });

    detail.replaceChildren(
      h('article', { class: 'message' },
        h('header', { class: 'message-head' },
          h('div', { class: 'title-row' },
            h('span', { class: `badge ${m.kind}` }, m.kind === 'recv' ? '받은 쪽지' : '보낸 쪽지'),
            h('button', { class: 'btn btn-ghost print-btn', onclick: () => window.print(), title: 'PDF로 저장하려면 인쇄 창에서 "PDF로 저장"을 고르세요' }, '인쇄 / PDF')),
          h('h2', {}, m.subject || '(제목 없음)'),
          meta),
        files,
        readers,
        frame));
    detail.scrollTop = 0;
  }

  // ---------------------------------------------------------- events

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    state.kind = tab.dataset.kind;
    state.page = 1;
    loadList();
  }));

  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(state, {
      q: $('q').value.trim(), person: $('person').value.trim(),
      from: $('from').value, to: $('to').value, files: $('files').checked, page: 1,
    });
    loadList();
  });

  $('resetBtn').addEventListener('click', () => {
    $('searchForm').reset();
    Object.assign(state, { q: '', person: '', from: '', to: '', files: false, page: 1 });
    loadList();
  });

  $('collectBtn').addEventListener('click', async () => {
    const btn = $('collectBtn');
    btn.disabled = true;
    btn.textContent = '가져오는 중…';
    try {
      const r = await api('/api/collect', { method: 'POST' });
      const n = r.status.lastRun?.newMessages ?? 0;
      toast(n ? `새 쪽지 ${n}건을 보관했습니다.` : '새로 보관할 쪽지가 없습니다.');
      await Promise.all([loadStatus(), loadList()]);
    } catch (err) {
      toast('가져오기에 실패했습니다. 바탕화면의 오류 안내 파일을 확인해 주세요.', 6000);
      loadStatus();
    } finally {
      btn.disabled = false;
      btn.textContent = '지금 가져오기';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.replace('/login');
  });

  loadStatus();
  loadList();
})();
