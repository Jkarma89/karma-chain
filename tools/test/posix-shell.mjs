// tools/test/posix-shell.mjs —— 给需要真跑 `.sh` 的测试找一个**看得见这个仓库**的 POSIX shell。
//
// ## 为什么这件事不是"直接 spawn('bash')"就完了
//
// 2026-09-18 回填 DoD 时发现 5 条集成断言在 Windows 上**一直是红的**，
// 而它们的失败长这样：
//
//   应当退出 10，实际 127        stderr:（空）
//   期望退出码 13，实际 -1
//
// 根因：**从 PowerShell 启动时 `bash` 解析到 `C:\Windows\system32\bash.exe`** ——
// 那是 **WSL 的启动器**，不是 Git Bash。它是另一个操作系统、另一套文件系统视图
// （仓库在它眼里是 `/mnt/f/...`），所以拿到 `C:/...` 的脚本路径必然 127。
// 而 `sh` 在 PowerShell 的 PATH 里**根本不存在**，`execFileSync` 直接起不来（-1）。
//
// 从 Git Bash 启动时同样的测试 12/12 通过 —— 也就是说
// **测试结果取决于你从哪个 shell 敲的 npm test**。一条会因启动方式而变的断言，
// 在一半场合里是永久红；而一条永远红的测试和一条永远不会红的一样坏：
// 它让整套集成失去信号（这 5 条红了多久没人知道，DoD 里写的是"125 通过"）。
//
// ## 判据：它看不看得见这个仓库
//
// 不去认"哪个 bash 是对的"（路径、版本号、发行名都会变），而是**问它一句话**：
// `test -d <仓库路径>`。看得见就能跑仓库里的 `.sh`，看不见就不能 ——
// WSL 那个因此被自然排除，不需要专门认它。
//
// 找不到时返回 `null`，调用方**带理由跳过**，不要以 127 收场：
// 一个说不出原因的失败会被当成噪声，而一次带理由的跳过是可以读的。
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../protocol/load.mjs';

/** 交给 POSIX shell 的路径一律走这里：MSYS 对 `C:\…` 形式的 argv 会做路径转换。 */
export const toPosixPath = (p) => String(p).split(String.fromCharCode(92)).join('/');

const candidates = () => {
  if (process.platform !== 'win32') return ['bash', 'sh'];
  const out = [];
  // Git 装在哪就用它带的那个 bash。`git --exec-path` 指向
  // `<GitRoot>/mingw64/libexec/git-core`，往上找到 `<GitRoot>` 再进 `bin`。
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const execPath = toPosixPath(r.stdout.trim());
    const at = execPath.indexOf('/mingw');
    if (at > 0) out.push(`${execPath.slice(0, at)}/bin/bash.exe`);
  }
  out.push('C:/Program Files/Git/bin/bash.exe');
  out.push('C:/Program Files (x86)/Git/bin/bash.exe');
  // 最后才试裸名字 —— 在 PowerShell 下它可能是 WSL，下面那一问会把它筛掉。
  out.push('bash');
  // 去重：`git --exec-path` 推出来的常与下面硬编码那条相同，
  // 而跳过理由里把同一条列两遍会让人以为试了两个不同的东西。
  return [...new Set(out)];
};

/**
 * 找一个能看见 `mustSee`（默认仓库根）的 POSIX shell。
 *
 * @returns {{cmd: string, checked: string[]}|null} 找不到时 `null`
 */
export function findPosixShell({ mustSee = REPO_ROOT } = {}) {
  const want = toPosixPath(mustSee);
  const checked = [];
  for (const cmd of candidates()) {
    checked.push(cmd);
    try {
      const r = spawnSync(cmd, ['-c', `test -d "${want}"`], {
        encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'ignore'],
      });
      if (r.status === 0) return { cmd, checked };
    } catch { /* 起不来就试下一个 */ }
  }
  return null;
}

/** 跳过用的那句话 —— 说清缺什么、试过什么，以及为什么不能当成通过。 */
export function skipReasonFor(found) {
  if (found) return undefined;
  const tried = candidates().join('、');
  return '找不到能看见本仓库的 POSIX shell（试过：' + tried + '）。'
    + '注意 Windows 上 `bash` 常常是 WSL 的启动器 —— 它看到的是另一套文件系统，'
    + '跑不了仓库里的 .sh。**这不是通过**：`.sh` 那一半在本次运行中未被验证。'
    + '装 Git for Windows，或从 Git Bash 里跑 npm test。';
}
