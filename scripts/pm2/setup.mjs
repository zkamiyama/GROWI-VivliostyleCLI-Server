#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');
const pm2Config = join(repoRoot, 'pm2.config.cjs');

if (!existsSync(pm2Config)) {
  console.error('[pm2:setup] pm2.config.cjs が見つかりません: %s', pm2Config);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const serverOnly = args.has('--server-only');
const proxyOnly = args.has('--proxy-only');

if (serverOnly && proxyOnly) {
  console.error('[pm2:setup] --server-only と --proxy-only は同時に指定できません。');
  process.exit(1);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(cmd, cmdArgs, label) {
  console.log(`\n[pm2:setup] ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed (exit ${code})`));
      }
    });
  });
}

const startArgs = ['pm2', 'start', pm2Config, '--update-env', '--time'];
if (serverOnly) {
  startArgs.push('--only', 'vivliostyle-cli-server');
} else if (proxyOnly) {
  startArgs.push('--only', 'vivliostyle-proxy');
}

(async () => {
  try {
    if (!skipBuild) {
      await run(npmCmd, ['run', 'build'], 'ビルドを実行');
    }
    await run(npxCmd, startArgs, 'PM2 プロセスを起動');
    await run(npxCmd, ['pm2', 'save'], 'PM2 プロセス一覧を保存');
    await run(npxCmd, ['pm2', 'status'], 'PM2 状態を表示');
    console.log('\n[pm2:setup] 完了しました。OS 起動時に復元するには `npx pm2 startup` も実行してください。');
  } catch (err) {
    console.error(`\n[pm2:setup] エラー: ${err.message}`);
    process.exit(1);
  }
})();
