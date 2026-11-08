import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/**
 * Native file picker for the local server. The analysis API reads streams by
 * path, so the dialog has to run on the machine that owns the server rather
 * than in the browser (which never exposes a full local path).
 */

// The dialog used to be opened without an owner and from a non-foreground
// child process, so Windows' foreground lock left it behind the browser. A
// hidden topmost owner form fixes the z-order: an owned window is always drawn
// above its owner, and a topmost owner sits above every normal window. The
// owner stays on screen (transparent, 1x1) so the dialog is still centered
// normally instead of being placed off-screen.
const PICK_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
  '$owner.ShowInTaskbar = $false',
  '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
  '$owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.Opacity = 0',
  '$owner.TopMost = $true',
  '$owner.Show()',
  '$owner.Activate()',
  '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
  "$dialog.Title = 'Select MPEG-TS stream'",
  "$dialog.Filter = 'Transport streams (*.ts, *.m2ts, *.mts, *.trp)|*.ts;*.m2ts;*.mts;*.trp|All files (*.*)|*.*'",
  '$dialog.CheckFileExists = $true',
  '$dialog.Multiselect = $false',
  '$result = $dialog.ShowDialog($owner)',
  '$owner.Close()',
  'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }',
].join('\n');

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function pickFileWindows(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodeCommand(PICK_SCRIPT)],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (!finish()) return;
      child.kill();
      reject(new Error('file picker timed out'));
    }, 10 * 60 * 1000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (!finish()) return;
      reject(error);
    });
    child.on('close', (code) => {
      if (!finish()) return;
      const selected = stdout.trim();
      if (code !== 0) {
        reject(new Error(stderr.trim() || `file picker exited with code ${code ?? 'unknown'}`));
        return;
      }
      if (!selected) {
        resolve(null);
        return;
      }
      if (!existsSync(selected) || !statSync(selected).isFile()) {
        reject(new Error('selected path is not a file'));
        return;
      }
      resolve(selected);
    });
  });
}

/** Returns the chosen absolute path, or null when the user cancels. */
export function pickFile(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('the native file picker is only available on Windows'));
  }
  return pickFileWindows();
}
