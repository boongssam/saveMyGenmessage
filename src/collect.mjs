// Gen Messenger 쪽지 수집기
// 메신저의 쪽지 DB를 복사본으로만 읽어서, 보관함(archive.db)에 새 쪽지를 추가한다.
// 메신저 원본 파일은 절대 수정하지 않고, 보관함에서 쪽지를 지우지도 않는다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  openArchive, parseFileList, MESSAGE_COLUMNS, READER_COLUMNS, SAVED_COLUMNS,
} from './archive-db.mjs';

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SchemaChangedError extends Error {}

// ---------------------------------------------------------------- snapshot

/** Copy a SQLite DB (with its journal/WAL files) into a temp dir and open the copy. */
async function openSnapshot(srcPath, tmpDir) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dest = path.join(tmpDir, `${attempt}_${path.basename(srcPath)}`);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      if (fs.existsSync(srcPath + suffix)) fs.copyFileSync(srcPath + suffix, dest + suffix);
    }
    try {
      // Opened read-write only so SQLite can replay a copied journal; this is the temp copy.
      const db = new DatabaseSync(dest);
      const check = db.prepare('PRAGMA quick_check').get();
      if (Object.values(check)[0] === 'ok') return db;
      db.close();
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await sleep(3000); // the messenger may have been mid-write; try again
  }
  throw new Error(`메신저 DB 복사본이 손상되어 읽을 수 없습니다: ${srcPath}`);
}

function assertColumns(db, table, required, dbLabel) {
  const exists = db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table);
  if (!exists) return false;
  const have = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
  const missing = required.filter((c) => !have.has(c));
  if (missing.length) {
    throw new SchemaChangedError(
      `메신저 DB 구조가 바뀌었습니다 (${dbLabel} / ${table}: ${missing.join(', ')} 없음). ` +
      '보관함을 보호하기 위해 수집을 멈췄습니다.',
    );
  }
  return true;
}

// ---------------------------------------------------------------- messages

function importMessages(archive, src, label, stats) {
  const hasMessages = assertColumns(src, 'tbl_message', MESSAGE_COLUMNS, label);
  const hasReaders = assertColumns(src, 'tbl_message_userlist', READER_COLUMNS, label);
  const hasSaved = assertColumns(src, 'tbl_message_save', SAVED_COLUMNS, label);
  const now = nowIso();

  // Bodies are read as raw bytes: some contain bytes that are not valid UTF-8,
  // and reading them as text would silently replace those bytes.
  // node:sqlite binds JS numbers as REAL, which a TEXT column would store as '1.0'.
  const val = (v) => (v === undefined ? null : typeof v === 'number' ? String(v) : v);
  const selectCols = (cols) =>
    cols.map((c) => (c === 'msg_content' ? 'cast(msg_content as blob) as msg_content' : c)).join(', ');

  if (hasMessages) {
    const cols = MESSAGE_COLUMNS.join(', ');
    const findExisting = archive.prepare(
      'select id from messages where msg_kind = ? and msg_key = ? and msg_owner_id is ?',
    );
    const insert = archive.prepare(
      `insert into messages (${cols}, first_archived_at, last_seen_at)
       values (${MESSAGE_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
    );
    // Only fields the messenger fills in later are refreshed; nothing is ever cleared.
    const refresh = archive.prepare(
      `update messages set
         msg_recv_date = coalesce(nullif(:recv, ''), msg_recv_date),
         msg_read_date = coalesce(nullif(:read, ''), msg_read_date),
         msg_res_gubun = coalesce(:resg, msg_res_gubun),
         msg_res_date  = coalesce(nullif(:resd, ''), msg_res_date)
       where id = :id and (
         coalesce(nullif(:recv, ''), msg_recv_date) is not msg_recv_date or
         coalesce(nullif(:read, ''), msg_read_date) is not msg_read_date or
         coalesce(:resg, msg_res_gubun) is not msg_res_gubun or
         coalesce(nullif(:resd, ''), msg_res_date) is not msg_res_date)
       returning id`,
    );
    const touch = archive.prepare('update messages set last_seen_at = ? where id = ?');
    const insertAttachment = archive.prepare(
      `insert or ignore into attachments (message_id, seq, file_name, file_size, server_path)
       values (?, ?, ?, ?, ?)`,
    );

    for (const row of src.prepare(`select ${selectCols(MESSAGE_COLUMNS)} from tbl_message`).iterate()) {
      stats.sourceMessages++;
      const existing = findExisting.get(row.msg_kind, row.msg_key, row.msg_owner_id);
      if (existing) {
        // RETURNING is used because .changes is not reset by an UPDATE that matches no rows.
        const changed = refresh.get({
          recv: val(row.msg_recv_date), read: val(row.msg_read_date),
          resg: val(row.msg_res_gubun), resd: val(row.msg_res_date), id: existing.id,
        });
        if (changed) stats.updatedMessages++;
        touch.run(now, existing.id);
        continue;
      }
      const values = MESSAGE_COLUMNS.map((c) => val(row[c]));
      const { lastInsertRowid } = insert.run(...values, now, now);
      stats.newMessages++;
      parseFileList(row.msg_file_list).forEach((f, i) =>
        insertAttachment.run(lastInsertRowid, i, f.fileName, f.size, f.serverPath));
    }
  }

  if (hasReaders) {
    const upsert = archive.prepare(
      `insert into message_readers (${READER_COLUMNS.join(', ')}) values (?, ?, ?, ?, ?)
       on conflict (msg_key, msg_owner_id, user_id) do update set
         user_name = coalesce(nullif(excluded.user_name, ''), user_name),
         msg_read_date = coalesce(nullif(excluded.msg_read_date, ''), msg_read_date)`,
    );
    for (const row of src.prepare(`select ${READER_COLUMNS.join(', ')} from tbl_message_userlist`).iterate()) {
      upsert.run(...READER_COLUMNS.map((c) => val(row[c])));
    }
  }

  if (hasSaved) {
    const insert = archive.prepare(
      `insert or ignore into saved_messages (${SAVED_COLUMNS.join(', ')}, first_archived_at)
       values (${SAVED_COLUMNS.map(() => '?').join(', ')}, ?)`,
    );
    for (const row of src.prepare(`select ${selectCols(SAVED_COLUMNS)} from tbl_message_save`).iterate()) {
      insert.run(...SAVED_COLUMNS.map((c) => val(row[c])), now);
    }
  }
}

// ---------------------------------------------------------------- attachments

function* walkFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.isFile()) yield p;
  }
}

async function sha256File(p) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), hash);
  return hash.digest('hex');
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180);
}

async function importFiles(archive, cfg, stats, log) {
  const exists = archive.prepare('select id from stored_files where sha256 = ?');
  const insert = archive.prepare(
    `insert into stored_files (sha256, file_name, size, rel_path, source_path, archived_at)
     values (?, ?, ?, ?, ?, ?)`,
  );
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  for (const dir of cfg.attachmentDirs) {
    for (const file of walkFiles(dir)) {
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < 60_000) continue; // still being written
        const sha = await sha256File(file);
        if (exists.get(sha)) continue;
        const name = path.basename(file);
        const rel = path.join(month, `${sha.slice(0, 10)}_${safeName(name)}`);
        const dest = path.join(cfg.filesDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, dest);
        insert.run(sha, name, st.size, rel, file, nowIso());
        stats.newFiles++;
      } catch (err) {
        log(`첨부파일 복사 건너뜀 (${path.basename(file)}): ${err.message}`);
      }
    }
  }
  // Link archived files to attachment entries by file name.
  archive.exec(`
    update attachments set stored_file_id = (
      select id from stored_files s where s.file_name = attachments.file_name
      order by s.archived_at desc limit 1)
    where stored_file_id is null`);
}

// ---------------------------------------------------------------- backup / lock / log

function monthlyBackup(archive, cfg, log) {
  const month = new Date().toISOString().slice(0, 7);
  const dest = path.join(cfg.backupsDir, `archive_${month}.db`);
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(cfg.backupsDir, { recursive: true });
  archive.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  log(`월간 백업 생성: ${dest}`);
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (age < 60 * 60 * 1000) return false; // another run is in progress
    fs.writeFileSync(lockFile, String(process.pid)); // stale lock
  }
  return true;
}

function makeLogger(cfg) {
  fs.mkdirSync(cfg.logsDir, { recursive: true });
  const file = path.join(cfg.logsDir, `collect-${new Date().toISOString().slice(0, 7)}.log`);
  return (msg) => {
    const line = `[${new Date().toLocaleString('ko-KR')}] ${msg}`;
    fs.appendFileSync(file, line + os.EOL);
    console.log(line);
  };
}

// ---------------------------------------------------------------- main

export async function collect(cfg = loadConfig()) {
  const log = makeLogger(cfg);
  if (!acquireLock(cfg.lockFile)) {
    log('이미 다른 수집이 진행 중이라 이번 실행은 건너뜁니다.');
    return { skipped: true };
  }
  const archive = openArchive(cfg.archiveDb);
  const run = archive.prepare('insert into runs (started_at) values (?)').run(nowIso());
  const stats = { newMessages: 0, updatedMessages: 0, newFiles: 0, sourceMessages: 0 };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genmsg-archive-'));
  try {
    const sources = cfg.sourceDbs.filter((p) => fs.existsSync(p));
    if (!sources.length) throw new Error(`메신저 쪽지 DB를 찾을 수 없습니다: ${cfg.sourceDbs[0]}`);

    for (const srcPath of sources) {
      const src = await openSnapshot(srcPath, tmpDir);
      try {
        archive.exec('BEGIN');
        importMessages(archive, src, path.basename(srcPath), stats);
        archive.exec('COMMIT');
      } catch (err) {
        try { archive.exec('ROLLBACK'); } catch {}
        throw err;
      } finally {
        src.close();
      }
    }

    await importFiles(archive, cfg, stats, log);
    monthlyBackup(archive, cfg, log);

    const total = archive.prepare('select count(*) n from messages').get().n;
    archive.prepare(
      `update runs set finished_at=?, ok=1, new_messages=?, updated_messages=?, new_files=?,
         total_messages=?, source_messages=? where id=?`,
    ).run(nowIso(), stats.newMessages, stats.updatedMessages, stats.newFiles, total,
      stats.sourceMessages, run.lastInsertRowid);
    log(`수집 완료: 새 쪽지 ${stats.newMessages}건, 갱신 ${stats.updatedMessages}건, ` +
      `새 첨부 ${stats.newFiles}개 (메신저 ${stats.sourceMessages}건 / 보관함 총 ${total}건)`);
    try { if (fs.existsSync(cfg.alertFile)) fs.unlinkSync(cfg.alertFile); } catch {}
    return { ok: true, ...stats, total };
  } catch (err) {
    archive.prepare('update runs set finished_at=?, ok=0, error=? where id=?')
      .run(nowIso(), err.message, run.lastInsertRowid);
    log(`수집 실패: ${err.message}`);
    try {
      fs.writeFileSync(cfg.alertFile,
        `쪽지보관함 수집 중 문제가 생겼습니다.\r\n\r\n${new Date().toLocaleString('ko-KR')}\r\n${err.message}\r\n\r\n` +
        `자세한 기록: ${cfg.logsDir}\r\n다음 수집이 성공하면 이 파일은 자동으로 지워집니다.\r\n`);
    } catch {}
    return { ok: false, error: err.message };
  } finally {
    archive.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(cfg.lockFile); } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await collect();
  process.exitCode = result.ok || result.skipped ? 0 : 1;
}
