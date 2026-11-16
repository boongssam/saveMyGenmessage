// 수집이 실패했을 때 Windows 알림(화면 오른쪽 아래 팝업)을 띄운다.
// 알림을 못 띄워도 수집 결과에는 영향을 주지 않는다 (바탕화면 오류 파일은 따로 남는다).

import { spawn } from 'node:child_process';

// Windows PowerShell's own app id: lets a script show a toast without registering an app.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Show a Windows toast. Returns immediately; never throws. */
export function showToast(title, body) {
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$t = [System.Security.SecurityElement]::Escape(${psString(title)})
$b = [System.Security.SecurityElement]::Escape(${psString(body)})
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast duration=""long""><visual><binding template=""ToastGeneric""><text>$t</text><text>$b</text></binding></visual><audio src=""ms-winsoundevent:Notification.Default""/></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

export function notifyCollectFailed(errorMessage) {
  showToast('쪽지보관함: 쪽지 저장 실패',
    `${errorMessage}\n바탕화면의 '쪽지보관함 수집 오류.txt'를 확인하세요.`);
}
