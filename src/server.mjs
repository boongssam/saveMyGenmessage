// 쪽지보관함 화면 서버 — 이 PC(127.0.0.1)에서만 접속할 수 있다.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, decodeKorean, PROJECT_DIR } from './config.mjs';
import { openArchive } from './archive-db.mjs';
import { collect } from './collect.mjs';

const cfg = loadConfig();
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const SESSION_MS = 8 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const sessions = new Map(); // token -> expiry

// ---------------------------------------------------------------- auth

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function readAuth() {
  try { return JSON.parse(fs.readFileSync(cfg.authFile, 'utf8')); } catch { return null; }
}

function checkPassword(password) {
  const auth = readAuth();
  if (!auth) return false;
  const { hash } = hashPassword(password, auth.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(auth.hash, 'hex'));
}

function newSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

function isAuthed(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
  const exp = m && sessions.get(m[1]);
  if (!exp || exp < Date.now()) return false;
  sessions.set(m[1], Date.now() + SESSION_MS); // sliding expiry
  return true;
}

// ---------------------------------------------------------------- helpers

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('too large');
  }
  return data ? JSON.parse(data) : {};
}

const fmtDate = (s) =>
  s && s.length >= 12 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}` : '';

const likeEscape = (s) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** Remove anything executable from a stored message body before showing it. */
function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|meta[^>]*http-equiv)[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:/gi, '$1=$2#')
    // The messenger leaves a background-image placeholder in its HTML.
    .replace(/\sbackground\s*=\s*(["']?)@backgound_image@\1/gi, '');
}

let db;
function archive() {
  db ??= openArchive(cfg.archiveDb, { readOnly: true });
  return db;
}

// ---------------------------------------------------------------- queries

function buildFilter(q) {
  const where = [];
  const params = {};
  if (q.get('kind') === 'recv' || q.get('kind') === 'send') {
    where.push('m.msg_kind = :kind');
    params.kind = q.get('kind');
  }
  const text = q.get('q')?.trim();
  if (text) {
    // Every word must appear somewhere (subject, body, sender or recipients).
    text.split(/\s+/).slice(0, 8).forEach((w, i) => {
      where.push(`(m.msg_subject like :w${i} escape '\\' or m.msg_srh_content like :w${i} escape '\\'
        or m.msg_send_name like :w${i} escape '\\' or m.msg_recv_name like :w${i} escape '\\')`);
      params[`w${i}`] = likeEscape(w);
    });
  }
  const person = q.get('person')?.trim();
  if (person) {
    where.push(`(m.msg_send_name like :person escape '\\' or m.msg_recv_name like :person escape '\\')`);
    params.person = likeEscape(person);
  }
  const from = q.get('from')?.replaceAll('-', '');
  if (/^\d{8}$/.test(from ?? '')) { where.push('m.msg_send_date >= :from'); params.from = from + '000000'; }
  const to = q.get('to')?.replaceAll('-', '');
  if (/^\d{8}$/.test(to ?? '')) { where.push('m.msg_send_date <= :to'); params.to = to + '235959'; }
  if (q.get('files') === '1') where.push("m.msg_file_list <> ''");
  return { sql: where.length ? 'where ' + where.join(' and ') : '', params };
}

function listMessages(q) {
  const { sql, params } = buildFilter(q);
  const page = Math.max(1, Number(q.get('page')) || 1);
  const total = archive().prepare(`select count(*) n from messages m ${sql}`).get(params).n;
  const rows = archive().prepare(`
    select m.id, m.msg_kind kind, m.msg_subject subject, m.msg_send_name sender, m.msg_recv_name recipients,
      m.msg_send_date sent, m.msg_read_date read, (m.msg_file_list <> '') has_files,
      substr(replace(replace(m.msg_srh_content, char(13), ' '), char(10), ' '), 1, 140) preview,
      (select count(*) from message_readers r where r.msg_key = m.msg_key and r.msg_owner_id is m.msg_owner_id) reader_total,
      (select count(*) from message_readers r where r.msg_key = m.msg_key and r.msg_owner_id is m.msg_owner_id
         and r.msg_read_date <> '') reader_read
    from messages m ${sql}
    order by m.msg_send_date desc limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`).all(params);
  return {
    total, page, pageSize: PAGE_SIZE,
    items: rows.map((r) => ({ ...r, sent: fmtDate(r.sent), read: fmtDate(r.read), has_files: !!r.has_files })),
  };
}

function getMessage(id) {
  const m = archive().prepare('select * from messages where id = ?').get(id);
  if (!m) return null;
  const attachments = archive().prepare(`
    select a.seq, a.file_name, a.file_size, s.id stored_id
    from attachments a left join stored_files s on s.id = a.stored_file_id
    where a.message_id = ? order by a.seq`).all(id);
  const readers = archive().prepare(`
    select user_name, msg_read_date from message_readers
    where msg_key = ? and msg_owner_id is ? order by user_name`).all(m.msg_key, m.msg_owner_id);
  return {
    id: m.id,
    kind: m.msg_kind,
    subject: m.msg_subject,
    sender: m.msg_send_name,
    recipients: m.msg_recv_name,
    cc: m.msg_refer_recv_name,
    sent: fmtDate(m.msg_send_date),
    received: fmtDate(m.msg_recv_date),
    read: fmtDate(m.msg_read_date),
    archivedAt: m.first_archived_at,
    attachments,
    readers: readers.map((r) => ({ name: r.user_name, read: fmtDate(r.msg_read_date) })),
  };
}

function status() {
  const a = archive();
  const totals = a.prepare(`select count(*) total, sum(msg_kind='recv') recv, sum(msg_kind='send') send,
    min(msg_send_date) oldest, max(msg_send_date) newest from messages`).get();
  const lastRun = a.prepare('select * from runs order by id desc limit 1').get();
  const lastOk = a.prepare('select finished_at from runs where ok = 1 order by id desc limit 1').get();
  return {
    ...totals,
    oldest: fmtDate(totals.oldest), newest: fmtDate(totals.newest),
    lastRun: lastRun && { at: lastRun.finished_at ?? lastRun.started_at, ok: !!lastRun.ok, error: lastRun.error,
      newMessages: lastRun.new_messages },
    lastOkAt: lastOk?.finished_at ?? null,
  };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function exportCsv(q) {
  const { sql, params } = buildFilter(q);
  const rows = archive().prepare(`select * from messages m ${sql} order by m.msg_send_date desc`).all(params);
  const header = ['구분', '보낸 시각', '보낸 사람', '받는 사람', '참조', '제목', '첨부파일', '내용'];
  const lines = [header.join(',')];
  const fileNames = archive().prepare('select file_name from attachments where message_id = ? order by seq');
  for (const m of rows) {
    lines.push([
      m.msg_kind === 'recv' ? '받은 쪽지' : '보낸 쪽지', fmtDate(m.msg_send_date), m.msg_send_name,
      m.msg_recv_name, m.msg_refer_recv_name, m.msg_subject,
      fileNames.all(m.id).map((f) => f.file_name).join(' / '), (m.msg_srh_content ?? '').trim(),
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n'); // BOM so Excel reads Korean correctly
}

// ---------------------------------------------------------------- collection

let collecting = null;
function runCollectInChild() {
  collecting ??= new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(PROJECT_DIR, 'src', 'collect.mjs')],
      { windowsHide: true, stdio: 'ignore' });
    child.on('exit', (code) => { collecting = null; resolve(code === 0); });
    child.on('error', () => { collecting = null; resolve(false); });
  });
  return collecting;
}

// ---------------------------------------------------------------- routing

const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
  send(res, 200, fs.readFileSync(full), STATIC[path.extname(full)] ?? 'application/octet-stream', {
    'Content-Security-Policy': "default-src 'self'; frame-src 'self'; style-src 'self'; img-src 'self' data:",
    'X-Frame-Options': 'SAMEORIGIN',
  });
}

async function handle(req, res) {
  // Only accept requests addressed to this machine (blocks DNS-rebinding tricks).
  const okHosts = [`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`];
  if (!okHosts.includes(req.headers.host)) return send(res, 403, 'forbidden', 'text/plain');
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && !okHosts.some((h) => origin === `http://${h}`)) return send(res, 403, 'forbidden', 'text/plain');
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- public routes
  if (p === '/style.css' || p === '/login.js' || p === '/icon.svg') return serveStatic(res, p.slice(1));
  if (p === '/login') return serveStatic(res, 'login.html');
  if (p === '/api/auth-state') return send(res, 200, { needsSetup: !readAuth(), authed: isAuthed(req) });
  if (p === '/api/setup' && req.method === 'POST') {
    if (readAuth()) return send(res, 409, { error: '이미 비밀번호가 설정되어 있습니다.' });
    const { password } = await readJson(req);
    if (typeof password !== 'string' || password.length < 4) return send(res, 400, { error: '비밀번호는 4자 이상이어야 합니다.' });
    fs.writeFileSync(cfg.authFile, JSON.stringify(hashPassword(password)));
    newSession(res);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const { password } = await readJson(req);
    if (typeof password !== 'string' || !checkPassword(password)) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return send(res, 401, { error: '비밀번호가 맞지 않습니다.' });
    }
    newSession(res);
    return send(res, 200, { ok: true });
  }

  // --- everything below requires login
  if (!isAuthed(req)) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'login required' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p === '/app.js') return serveStatic(res, 'app.js');
  if (p === '/api/logout' && req.method === 'POST') {
    const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
    if (m) sessions.delete(m[1]);
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }
  if (p === '/api/status') return send(res, 200, status());
  if (p === '/api/messages') return send(res, 200, listMessages(url.searchParams));
  if (p === '/api/export.csv') {
    const name = `쪽지보관함_${new Date().toISOString().slice(0, 10)}.csv`;
    return send(res, 200, exportCsv(url.searchParams), 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
  }
  if (p === '/api/collect' && req.method === 'POST') {
    const ok = await runCollectInChild();
    return send(res, ok ? 200 : 500, { ok, status: status() });
  }

  let m;
  if ((m = /^\/api\/messages\/(\d+)$/.exec(p))) {
    const msg = getMessage(Number(m[1]));
    return msg ? send(res, 200, msg) : send(res, 404, { error: 'not found' });
  }
  if ((m = /^\/api\/messages\/(\d+)\/body$/.exec(p))) {
    const row = archive().prepare('select msg_content from messages where id = ?').get(Number(m[1]));
    if (!row) return send(res, 404, 'not found', 'text/plain');
    const html = sanitizeHtml(decodeKorean(Buffer.from(row.msg_content ?? [])));
    const page = `<!doctype html><meta charset="utf-8"><base target="_blank">` +
      `<style>body{font-family:'Malgun Gothic',sans-serif;font-size:14px;margin:12px;word-break:break-word}` +
      `img{max-width:100%;height:auto}</style>${html}`;
    return send(res, 200, page, 'text/html; charset=utf-8', {
      // The body is shown with scripts disabled and no network access.
      'Content-Security-Policy': "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; " +
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    });
  }
  if ((m = /^\/api\/files\/(\d+)$/.exec(p))) {
    const f = archive().prepare('select * from stored_files where id = ?').get(Number(m[1]));
    const full = f && path.join(cfg.filesDir, f.rel_path);
    if (!f || !full.startsWith(cfg.filesDir) || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(full).size,
      'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
    });
    return fs.createReadStream(full).pipe(res);
  }
  return send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- start

export async function start() {
  if (!fs.existsSync(cfg.archiveDb)) await collect(cfg); // first launch: build the archive
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: '서버 오류가 발생했습니다.' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', resolve);
  });
  console.log(`쪽지보관함: http://127.0.0.1:${cfg.port}`);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((err) => {
    if (err.code === 'EADDRINUSE') console.log('보관함 화면이 이미 실행 중입니다.');
    else { console.error(err); process.exitCode = 1; }
  });
}
