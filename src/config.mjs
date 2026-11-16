import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Decode bytes that may be UTF-8 or (older Korean Windows files) EUC-KR/CP949. */
export function decodeKorean(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

/** Read downloaddir= from the messenger's ucw_config.ini, if present. */
function readMessengerDownloadDir(messengerDir) {
  try {
    const text = decodeKorean(fs.readFileSync(path.join(messengerDir, 'ucw_config.ini')));
    const m = text.match(/^downloaddir=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function loadConfig(configPath = process.env.SGM_CONFIG || path.join(PROJECT_DIR, 'config.json')) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const messengerDir = raw.messengerDir;
  const archiveDir = raw.archiveDir;
  const downloadDir = raw.downloadDir ?? readMessengerDownloadDir(messengerDir);
  return {
    ...raw,
    messengerDir,
    archiveDir,
    // Message databases inside the messenger, in the order they are collected.
    sourceDbs: [
      path.join(messengerDir, 'Data', 'message', 'msg_data.db'),
      path.join(messengerDir, 'Data', 'message', 'msg_data_user.db'),
    ],
    // Folders whose files are copied into the archive as attachments.
    attachmentDirs: [path.join(messengerDir, 'dn_temporary'), downloadDir].filter(Boolean),
    archiveDb: path.join(archiveDir, 'archive.db'),
    filesDir: path.join(archiveDir, 'files'),
    backupsDir: path.join(archiveDir, 'backups'),
    logsDir: path.join(archiveDir, 'logs'),
    authFile: path.join(archiveDir, 'auth.json'),
    lockFile: path.join(archiveDir, '.collect.lock'),
    alertFile: path.join(os.homedir(), 'Desktop', '쪽지보관함 수집 오류.txt'),
    port: raw.port ?? 8765,
  };
}
