import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Columns copied verbatim from the messenger's tbl_message. */
export const MESSAGE_COLUMNS = [
  'msg_key', 'group_id', 'msg_gubun', 'msg_kind', 'msg_subject', 'msg_owner_id',
  'msg_send_id', 'msg_send_name', 'msg_send_date', 'msg_res_gubun', 'msg_res_date',
  'msg_recv_date', 'msg_read_date', 'msg_recv_ids', 'msg_refer_recv_ids',
  'msg_hidden_recv_ids', 'msg_recv_name', 'msg_refer_recv_name', 'msg_hidden_recv_name',
  'msg_file_list', 'msg_srh_content', 'msg_etc1', 'msg_etc2', 'msg_etc3',
  'msg_back_image', 'msg_content',
];

export const READER_COLUMNS = ['msg_key', 'msg_owner_id', 'user_id', 'user_name', 'msg_read_date'];

export const SAVED_COLUMNS = [
  'msg_key', 'msg_kind', 'msg_subject', 'msg_owner_id', 'msg_save_date', 'msg_hash',
  'msg_recv_ids', 'msg_refer_recv_ids', 'msg_hidden_recv_ids', 'msg_srh_content', 'msg_content',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  ${MESSAGE_COLUMNS.map((c) => `${c} ${c === 'msg_content' ? 'BLOB' : 'TEXT'}`).join(',\n  ')},
  first_archived_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (msg_kind, msg_key, msg_owner_id)
);
CREATE INDEX IF NOT EXISTS messages_send_date ON messages (msg_send_date);

CREATE TABLE IF NOT EXISTS message_readers (
  ${READER_COLUMNS.map((c) => `${c} TEXT`).join(', ')},
  UNIQUE (msg_key, msg_owner_id, user_id)
);

CREATE TABLE IF NOT EXISTS saved_messages (
  id INTEGER PRIMARY KEY,
  ${SAVED_COLUMNS.map((c) => `${c} ${c === 'msg_content' ? 'BLOB' : 'TEXT'}`).join(',\n  ')},
  first_archived_at TEXT NOT NULL,
  UNIQUE (msg_owner_id, msg_key, msg_save_date)
);

CREATE TABLE IF NOT EXISTS attachments (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  seq INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_size TEXT,
  server_path TEXT,
  stored_file_id INTEGER REFERENCES stored_files(id),
  PRIMARY KEY (message_id, seq)
);
CREATE INDEX IF NOT EXISTS attachments_name ON attachments (file_name);

CREATE TABLE IF NOT EXISTS stored_files (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  source_path TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stored_files_name ON stored_files (file_name);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  new_messages INTEGER,
  updated_messages INTEGER,
  new_files INTEGER,
  total_messages INTEGER,
  source_messages INTEGER,
  error TEXT
);
`;

export function openArchive(dbPath, { readOnly = false } = {}) {
  if (!readOnly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
  }
  return db;
}

/**
 * Parse msg_file_list. Each attachment is 4 '|'-separated fields:
 *   server;port | file name | size | server path |
 */
export function parseFileList(list) {
  if (!list) return [];
  const parts = list.split('|');
  const out = [];
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const fileName = parts[i + 1]?.trim();
    if (!fileName) continue;
    out.push({ fileName, size: parts[i + 2]?.trim() || null, serverPath: parts[i + 3]?.trim() || null });
  }
  return out;
}
