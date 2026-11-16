import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collect } from '../src/collect.mjs';
import { parseFileList, MESSAGE_COLUMNS, READER_COLUMNS } from '../src/archive-db.mjs';

/** Build a fake messenger folder with a msg_data.db shaped like Gen Messenger's. */
function fakeMessenger({ dropColumn } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genmsg-test-'));
  const msgDir = path.join(dir, 'messenger', 'Data', 'message');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'messenger', 'dn_temporary'));
  const db = new DatabaseSync(path.join(msgDir, 'msg_data.db'));
  const cols = MESSAGE_COLUMNS.filter((c) => c !== dropColumn);
  db.exec(`create table tbl_message (${cols.map((c) => `${c} ${c === 'msg_content' ? 'BLOB' : c === 'msg_res_gubun' ? 'integer' : 'text'}`).join(', ')})`);
  db.exec(`create table tbl_message_userlist (${READER_COLUMNS.join(', ')})`);
  db.close();
  const archiveDir = path.join(dir, 'archive');
  const cfg = {
    sourceDbs: [path.join(msgDir, 'msg_data.db')],
    attachmentDirs: [path.join(dir, 'messenger', 'dn_temporary')],
    archiveDb: path.join(archiveDir, 'archive.db'),
    filesDir: path.join(archiveDir, 'files'),
    backupsDir: path.join(archiveDir, 'backups'),
    logsDir: path.join(archiveDir, 'logs'),
    lockFile: path.join(archiveDir, '.lock'),
    alertFile: path.join(dir, 'ALERT.txt'),
  };
  return { dir, cfg, srcPath: cfg.sourceDbs[0] };
}

function addMessage(srcPath, key, extra = {}) {
  const db = new DatabaseSync(srcPath);
  const row = {
    msg_key: key, msg_kind: 'recv', msg_owner_id: 'me', msg_subject: `제목 ${key}`,
    msg_send_name: '홍길동', msg_send_date: '20260901093000', msg_res_gubun: 1, msg_read_date: '',
    msg_file_list: '', msg_srh_content: '내용', msg_content: '<p>본문 \xff</p>', ...extra,
  };
  const keys = Object.keys(row);
  db.prepare(`insert into tbl_message (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
  db.close();
}

const archiveCount = (cfg) => {
  const db = new DatabaseSync(cfg.archiveDb, { readOnly: true });
  try { return db.prepare('select count(*) n from messages').get().n; } finally { db.close(); }
};

test('first run archives everything, second run adds nothing', async () => {
  const { cfg, srcPath } = fakeMessenger();
  addMessage(srcPath, 'a'); addMessage(srcPath, 'b');
  const r1 = await collect(cfg);
  assert.equal(r1.ok, true);
  assert.equal(r1.newMessages, 2);
  const r2 = await collect(cfg);
  assert.equal(r2.newMessages, 0);
  assert.equal(r2.updatedMessages, 0);
  assert.equal(archiveCount(cfg), 2);
});

test('messages deleted from the messenger stay in the archive', async () => {
  const { cfg, srcPath } = fakeMessenger();
  addMessage(srcPath, 'old'); addMessage(srcPath, 'new');
  await collect(cfg);
  const db = new DatabaseSync(srcPath);
  db.exec("delete from tbl_message where msg_key = 'old'");
  db.close();
  const r = await collect(cfg);
  assert.equal(r.ok, true);
  assert.equal(archiveCount(cfg), 2);
});

test('a later read date is picked up as an update', async () => {
  const { cfg, srcPath } = fakeMessenger();
  addMessage(srcPath, 'a');
  await collect(cfg);
  const db = new DatabaseSync(srcPath);
  db.exec("update tbl_message set msg_read_date = '20260902100000'");
  db.close();
  const r = await collect(cfg);
  assert.equal(r.updatedMessages, 1);
});

test('body bytes are preserved exactly, even when not valid UTF-8', async () => {
  const { cfg, srcPath } = fakeMessenger();
  const bytes = Buffer.from([0x3c, 0x70, 0x3e, 0xb0, 0xa1, 0xff, 0x3c, 0x2f, 0x70, 0x3e]);
  addMessage(srcPath, 'raw', { msg_content: bytes });
  await collect(cfg);
  const db = new DatabaseSync(cfg.archiveDb, { readOnly: true });
  const stored = Buffer.from(db.prepare('select msg_content c from messages').get().c);
  db.close();
  assert.deepEqual(stored, bytes);
});

test('a changed messenger schema stops collection without touching the archive', async () => {
  const { cfg } = fakeMessenger({ dropColumn: 'msg_subject' });
  const r = await collect(cfg);
  assert.equal(r.ok, false);
  assert.match(r.error, /구조가 바뀌었습니다/);
  assert.ok(fs.existsSync(cfg.alertFile), 'desktop alert file is written');
});

test('attachments are parsed and linked to archived files', async () => {
  const { dir, cfg, srcPath } = fakeMessenger();
  const list = '10.0.0.1;8080|가정통신문.hwp|12,345|_server/2026-09-01/가정통신문.hwp|10.0.0.1;8080|명단.xlsx|999|_server/x/명단.xlsx|';
  addMessage(srcPath, 'f', { msg_file_list: list });
  const file = path.join(dir, 'messenger', 'dn_temporary', '가정통신문.hwp');
  fs.writeFileSync(file, 'hwp');
  const past = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(file, past, past);
  const r = await collect(cfg);
  assert.equal(r.newFiles, 1);
  const db = new DatabaseSync(cfg.archiveDb, { readOnly: true });
  const rows = db.prepare('select file_name, stored_file_id from attachments order by seq').all();
  db.close();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].stored_file_id);
  assert.equal(rows[1].stored_file_id, null);
});

test('parseFileList', () => {
  assert.deepEqual(parseFileList(''), []);
  assert.deepEqual(parseFileList('1.2.3.4;1|a b.pdf|1,024|_s/a b.pdf|'), [
    { fileName: 'a b.pdf', size: '1,024', serverPath: '_s/a b.pdf' },
  ]);
});
