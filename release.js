#!/usr/bin/env node
/**
 * 一键发布：把代码推到 GitHub，并把便携版 exe 上传为 Release 附件。
 *
 * 用法： npm run release
 *        node release.js            （等价）
 *        node release.js --no-push  （只做 Release，不推代码）
 *
 * 前置条件：
 *   1. 已执行 npm run build，dist/ 里有对应版本号的便携 exe；
 *   2. 网络能访问 github.com（本机走代理时需要代理正常）；
 *   3. gh 已登录：gh auth login
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const pkg = require('./package.json');
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const EXE = path.join(ROOT, 'dist', `TomatoClock-Portable-${VERSION}.exe`);
const SKIP_PUSH = process.argv.includes('--no-push');

// gh 可执行文件：优先用本机已下载的，其次靠 PATH
const GH_CANDIDATES = ['E:\\GitHubCli\\gh.exe', 'gh'];
function resolveGh() {
  for (const c of GH_CANDIDATES) {
    if (c === 'gh') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'gh';
}

function run(cmd, args, { allowFail = false } = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.error) {
    console.error(`[错误] 无法执行 ${cmd}：${r.error.message}`);
    if (!allowFail) process.exit(1);
    return 1;
  }
  if (r.status !== 0 && !allowFail) process.exit(r.status || 1);
  return r.status || 0;
}

const NOTES = [
  `番茄钟 v${VERSION}`,
  '',
  '本次更新：',
  '- 学习/休息时长的分钟上限由 59 调整为 60',
  '- 新增「连续学习」：无倒计时，正计时一直学，时间照常计入「本次学习」并可记录入账',
  '',
  '使用说明：',
  '- 便携版，免安装，双击即用（Windows 10/11 64 位）',
  '- 首次运行如提示“Windows 已保护你的电脑”，点“更多信息” → “仍要运行”即可',
  '- 学习记录 学习记录.xlsx 生成在 exe 同目录，请放在有写权限的文件夹（桌面／文档／其他数据盘）',
].join('\n');

// ---------- 1. 前置检查 ----------
if (!fs.existsSync(EXE)) {
  console.error(`[错误] 找不到便携版文件：\n  ${EXE}\n请先执行：npm run build`);
  process.exit(1);
}
console.log(`版本：${VERSION}    标签：${TAG}`);
console.log(`附件：${EXE}（${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB）`);

const GH = resolveGh();

// ---------- 2. 推送代码 ----------
if (!SKIP_PUSH) {
  console.log('\n=== 推送代码 ===');
  run('git', ['push']);
} else {
  console.log('\n（已跳过 git push）');
}

// ---------- 3. 创建 Release 并上传 exe ----------
console.log('\n=== 发布 Release ===');
const status = run(
  GH,
  ['release', 'create', TAG, EXE, '--title', `番茄钟 ${TAG}`, '--notes', NOTES],
  { allowFail: true }
);

if (status !== 0) {
  console.log('\n创建 Release 失败（标签可能已存在），改为上传附件到已有 Release…');
  const upStatus = run(GH, ['release', 'upload', TAG, EXE, '--clobber'], { allowFail: true });
  if (upStatus !== 0) {
    console.error('\n[失败] 发布未完成。常见原因：');
    console.error('  1) 网络无法访问 github.com（检查代理是否正常）；');
    console.error('  2) gh 未登录或 token 过期，执行：gh auth login');
    process.exit(1);
  }
}

console.log(`\n完成 ✓  https://github.com/Mangran-mang/Pomodoro-Timer/releases/tag/${TAG}`);
