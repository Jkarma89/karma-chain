// 宿主薄封装（`scripts/*.ps1` 与 `scripts/*.sh`）的可移植性守卫。
//
// 契约（001 cli-interface.md）要求 `.ps1` 与 `.sh` 是**等价**的薄封装。但等价不只是逻辑等价 ——
// 2026-09-08 的跨机部署一次性暴露出四类问题：前三类只在 **Windows PowerShell 5.1** 上出现
// （它们在 pwsh 7 下都不复现，因此长期没被察觉 —— 我一直用 pwsh 7 验证，
// 而运维方用的是系统自带的 5.1），第四类反过来只在 **Linux** 上出现。
//
// ## 一、缺 UTF-8 BOM 会让 5.1 按 GBK 解码，并**吞掉换行**
//
// UTF-8 的中文是 3 字节，GBK 按 2 字节配对。若某行注释在换行前的字节数为**奇数**，
// GBK 就会把最后一个字节与行尾的 `\n`(0x0A) 配成一个字符 —— 换行被吃掉，**下一行被并进注释**。
//
// 实际后果：`devnet-bootstrap.ps1` 第 1 行是中文注释（121 字节，奇数），于是第 2 行
// `. (Join-Path $PSScriptRoot '_devnet-common.ps1')` 被并进注释、从未执行 →
// `Get-DevnetContext` 未定义 → `$ctx` 为 null → `$bootstrap` 为 null →
// `docker compose -f  run --rm bootstrap` 把 `run` 当成 `-f` 的值 → 报 `unknown flag: --rm`。
// 三个看似无关的错误其实是同一个根因的连锁。
//
// 更危险的是它**看字节数运气**：`devnet-topology.ps1` 第 1 行恰好 84 字节（偶数），
// 所以它一直是好的 —— 这种"侥幸通过"比全体失败更难发现。
//
// ## 二、`2>$null` 抑制不住原生命令的 stderr
//
// 配合 `$ErrorActionPreference='Stop'`，docker 写到 stderr 的内容会变成 NativeCommandError
// 并打印一大段红字。跨机形态下每台机器只承载本边界的节点，而脚本遍历 active.env 里
// **全部** 7 个节点 id，于是每轮轮询有 6 个必然失败 —— 启动过程会被刷屏，真正的失败被埋掉。
// 统一改用 `_devnet-common.ps1` 的 `Invoke-Quiet`（`2>&1` 合流 + 退出码判断）。
//
// ## 三、`Set-StrictMode -Version Latest` 会泄漏进第三方 .ps1
//
// StrictMode 是**会话级**的，不是脚本级。`_devnet-common.ps1` 在顶部设了它，
// 于是同一会话里后续被调用的任何 .ps1 都在严格模式下运行 —— 包括 npm 自带的 `npm.ps1` shim，
// 它第 30 行访问 `$MyInvocation.Statement`（该属性在这条调用路径上不存在）。
// 非严格模式下这是 $null，严格模式下抛 PropertyNotFoundStrict。
//
// 实际后果：`devnet-bootstrap.ps1` 建链全部成功（链已建好、7 个卷已播种），
// 却在最后一步 `npm run node:render` 崩掉 —— 一个纯属外来的失败盖在成功的操作上。
// 修法不是去掉 StrictMode（它在我们自己的代码里抓到过真 bug），而是**不在宿主上调 npm**：
// 直接调 `node tools/protocol/render-all.mjs`。容器内的 npm 不受影响（另一个会话）。
//
// ## 四、在 Windows 上创建的 `.sh` 没有可执行位，Linux 上 clone 出来就跑不了
//
// NTFS 没有 POSIX 权限位，git 于是把所有 `.sh` 记成 `100644`。Windows 侧毫无症状
// （Git Bash 不看这个位），Linux 侧 clone 出来的脚本没有 `+x`，直接执行报
// `command not found` —— 而这个措辞会把人引向"脚本不存在 / PATH 不对"，而不是权限。
//
// 2026-09-08 在 ubuntu-1 上实测到：`sudo KARMACHAIN_DOMAIN=ubuntu-1 scripts/devnet-start.sh`
// → `sudo: scripts/devnet-start.sh: command not found`。这直接打穿 SC-007 的
// "从克隆到可用链 3 步"：Linux 上得先 chmod 才能开始，那就不是 3 步。
//
// 只管**用户直接执行的入口**。被 `.` source 的库应当保持 644，它们按约定以 `_` 开头
// （`scripts/_devnet-common.sh`、`scripts/_devnet-common.ps1`）；`docker/lib/*.sh` 同理；
// 容器 entrypoint 由各自 Dockerfile 的 `RUN chmod +x` 兜住。
//
// 判据只能取 git 索引里的模式位，不能看工作区 —— 在 Windows 上 stat 出来的权限没有意义。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const SCRIPTS = resolve(REPO_ROOT, 'scripts');
const ps1Files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.ps1')).sort();
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

// 逐条走一个 .ps1 的**逻辑行**，只把代码交给 visit —— 行注释与块注释 `<# ... #>` 都跳过。
// 三个守卫共用：其中两个的违规写法恰好会出现在解释它为什么不可靠的文档里。
//
// 为什么必须按逻辑行而不是物理行：PowerShell 用行尾反引号续行，而守卫的判断依赖
// 同一条语句里的其他 token。实例：`devnet-verify.ps1` 把 `docker run` 拆成多行后，
// 末行只剩 `karmachain/verify:local npm run verify -- @args` —— npm 守卫看不到
// `docker`，于是把一条容器内的调用误判成宿主调用。行号取逻辑行的起始行。
function eachCodeLine(file, visit) {
  const lines = readFileSync(join(SCRIPTS, file), 'utf8').split('\n');
  let inBlockComment = false;
  let pending = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (/<#/.test(line)) inBlockComment = true;
    const wasInBlock = inBlockComment;
    if (/#>/.test(line)) inBlockComment = false;
    if (wasInBlock || /^\s*#/.test(line)) return;

    const continues = /`\s*$/.test(line);
    const body = continues ? line.replace(/`\s*$/, ' ') : line;
    if (pending) pending.text += body;
    else pending = { text: body, lineNo: i + 1 };
    if (!continues) { visit(pending.text, pending.lineNo); pending = null; }
  });
  if (pending) visit(pending.text, pending.lineNo);
}

describe('宿主薄封装脚本的跨平台可移植性', () => {
  test('存在 .ps1 脚本可测 —— 否则本套件在空转', () => {
    assert.ok(ps1Files.length >= 10, `期望至少 10 个 .ps1，实际 ${ps1Files.length}`);
  });

  test('每个 .ps1 都以 UTF-8 BOM 开头', () => {
    const missing = ps1Files.filter((f) => !readFileSync(join(SCRIPTS, f)).subarray(0, 3).equals(BOM));
    assert.deepEqual(missing, [],
      `以下 .ps1 缺 UTF-8 BOM：${missing.join(', ')}\n`
      + '  Windows PowerShell 5.1 对无 BOM 的文件按系统 ANSI 代码页（中文环境为 GBK）解码。\n'
      + '  中文注释被误解码时可能吞掉行尾换行，把下一行代码并进注释 —— 静默失效，且看字节数运气。\n'
      + '  修法：在文件开头写入 EF BB BF。');
  });

  test('不使用 2>$null 抑制原生命令的 stderr —— 用 Invoke-Quiet', () => {
    const offenders = [];
    for (const f of ps1Files) {
      eachCodeLine(f, (line, n) => {
        if (line.includes('2>$null')) offenders.push(`${f}:${n}: ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(offenders, [],
      `以下位置用 2>$null 抑制原生命令的 stderr，它不可靠：\n  ${offenders.join('\n  ')}\n`
      + '  改用 _devnet-common.ps1 的 Invoke-Quiet { ... }（2>&1 合流 + 退出码判断）。');
  });

  test('不在宿主上直接调 npm —— StrictMode 会弄坏 npm 自己的 .ps1 shim', () => {
    const offenders = [];
    for (const f of ps1Files) {
      eachCodeLine(f, (line, n) => {
        // 容器内的 npm 跑在另一个会话里，StrictMode 传不进去 —— 那是允许的。
        if (line.includes('docker')) return;
        // 引号里的 npm 是给人看的提示文本（"先运行 'npm run node:render'"），不是调用。
        const code = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
        if (/(^|[\s;(|&{])npm(\.cmd|\.ps1)?\s/.test(code)) {
          offenders.push(`${f}:${n}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      `以下 .ps1 在宿主上直接调 npm：\n  ${offenders.join('\n  ')}\n`
      + '  _devnet-common.ps1 的 Set-StrictMode -Version Latest 是会话级的，会泄漏进 npm 自己的\n'
      + '  npm.ps1 shim（它访问不存在的 $MyInvocation.Statement），报 PropertyNotFoundStrict。\n'
      + '  改为直接调对应的 node 脚本，例如 node tools/protocol/render-all.mjs。');
  });

  test('Invoke-Quiet 存在于公共模块，且引用它的脚本都点引用了该模块', () => {
    const common = readFileSync(join(SCRIPTS, '_devnet-common.ps1'), 'utf8');
    assert.match(common, /function Invoke-Quiet/, '公共模块应定义 Invoke-Quiet');

    for (const f of ps1Files) {
      if (f === '_devnet-common.ps1') continue;
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      if (!src.includes('Invoke-Quiet')) continue;
      assert.match(src, /_devnet-common\.ps1/,
        `${f} 用了 Invoke-Quiet 但没有点引用 _devnet-common.ps1`);
    }
  });

  // 2026-09-21 在 ubuntu-5 上现场打穿了这条守卫**原先的作用域**：
  // 它只查 `scripts/`，而 `tools/membership/gen-node-keys.sh` 住在 `tools/`，
  // 于是以 100644 进了仓库，新机器上 clone 出来直接执行报「权限不够」。
  // docs/devnet.md §11.2 与脚本自己的用法行都写着直接执行它 ——
  // **守卫声称的性质（"宿主直接执行的 .sh 必须可执行"）比它实际查的范围窄**，
  // 这正是"检查器自己没有被检查"的那个形状。范围因此扩到全仓库。
  test('宿主直接执行的 *.sh 在 git 索引里都是 100755 —— 否则 Linux 上 clone 完跑不了', () => {
    let out;
    try {
      out = execFileSync('git', ['ls-files', '-s', '--', '*.sh'], {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // 不是 git 工作树（例如从 tarball 解出来跑测试）—— 无从判定，不误报。
      return;
    }
    const entries = out.split('\n')
      .map((l) => l.match(/^(\d{6})\s+\S+\s+\d+\t(.+\.sh)$/))
      .filter(Boolean)
      .map((m) => ({ mode: m[1], path: m[2] }))
      // `docker/` 下的不由宿主执行：或被 `.` source，或拷进镜像后由各自
      // Dockerfile 的 `RUN chmod +x` 兜住。它们保持 644 是对的。
      .filter(({ path }) => !path.startsWith('docker/'));
    assert.ok(entries.length >= 14, `期望至少 14 个受管 *.sh，实际 ${entries.length}`);

    // 入口必须可执行；`_` 开头的是被 source 的库，应当保持 644 —— 两个方向都断言，
    // 否则"给库也加上 +x"这种反向漂移不会被发现。
    const sourced = (p) => p.split('/').pop().startsWith('_');
    const wrong = entries
      .filter(({ mode, path }) => (sourced(path) ? mode !== '100644' : mode !== '100755'))
      .map(({ mode, path }) => `${path}（${mode}，期望 ${sourced(path) ? '100644' : '100755'}）`);
    assert.deepEqual(wrong, [],
      `以下 *.sh 的模式位不对：\n  ${wrong.join('\n  ')}\n`
      + '  NTFS 没有权限位，在 Windows 上新建的脚本会被记成 100644。Windows 侧毫无症状，\n'
      + '  Linux 上 clone 出来直接执行会报 command not found / 权限不够 ——\n'
      + '  前者的措辞会把人引向 PATH 而不是权限。\n'
      + '  修法：git update-index --chmod=+x <文件…> 然后提交。');
  });

  // 2026-09-26：上面那条**在唯一能拦住我的那一刻是瞎的**。
  // `git ls-files` 只列**已跟踪**的文件，而新写的 scripts/devnet-primary.sh 当时还没
  // `git add`。于是 1621 条断言全绿 → 提交 → 记录里赫然是 `create mode 100644`。
  // 守卫存在、写得也对，**却只在木已成舟之后才有发言权**。
  //
  // 未跟踪的 `*.sh` 在 Windows 上被 `git add` 时必然记成 100644（NTFS 没有权限位），
  // 所以"还没跟踪"这件事本身就足以预测结果 —— 在这里报出来，比提交后再报有用。
  test('还没被 git 跟踪的 *.sh 也要报出来 —— 否则守卫只在提交之后才有发言权', () => {
    let out;
    try {
      out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '*.sh'], {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return;   // 不是 git 工作树 —— 无从判定，不误报
    }
    const pending = out.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => !p.startsWith('docker/'))
      .filter((p) => !p.split('/').pop().startsWith('_'));
    assert.deepEqual(pending, [],
      `以下 *.sh 还没被 git 跟踪：\n  ${pending.join('\n  ')}\n`
      + '  在 Windows 上 git add 会把它们记成 100644（NTFS 没有权限位），\n'
      + '  而 Linux 上 clone 出来直接执行会报权限不够。\n'
      + '  修法：git add <文件…> && git update-index --chmod=+x <文件…>\n'
      + '  —— 先 add 再改模式，然后这一条与上一条都会绿。');
  });
  // 2026-09-22 在 ubuntu-5 上：`devnet-start.sh` 的就绪判据全压在 `curl` 上，
  // 而那些调用都带 `2>/dev/null`。那台机器按 `apt-get install docker.io jq git` 装的，
  // **没有 curl** —— 于是 chain_id() 静默返回空字符串，轮询永远不匹配，
  // 等满 300 秒后报「300s 内未就绪」，还附上一段关于「至少 6 个在线」的解释。
  // 当时节点 healthy、在服务，本机代理从别的机器问过去 HTTP 200 且返回 0x4edd。
  // 一句朝错误方向的诊断，让人去查链和法定人数，而真正缺的是一个包。
  //
  // 退出码 10「前置依赖缺失」本来就在这些脚本的退出码表里 —— 这一路失败该走那条路。
  // 守的是这个类，不是那一个文件：外部命令决定成败时，缺了它必须**当场说**，
  // 不能让它伪装成超时或"链有问题"。
  test('用到 curl 的 scripts/*.sh 必须先检查 curl 在不在', () => {
    const offenders = readdirSync(SCRIPTS)
      .filter((f) => f.endsWith('.sh'))
      .map((f) => ({ f, text: readFileSync(join(SCRIPTS, f), 'utf8') }))
      .filter(({ text }) => /(^|[^\w-])curl\s/m.test(text))
      .filter(({ text }) => !text.includes('command -v curl'))
      .map(({ f }) => f);
    assert.deepEqual(offenders, [],
      `以下脚本用了 curl 却没有前置检查：\n  ${offenders.join('\n  ')}\n`
      + '  缺了它这些调用会静默返回空字符串（它们都带 2>/dev/null），\n'
      + '  症状是等满超时后报"未就绪"—— 而那句话指向链，不指向缺包。\n'
      + '  修法：在 docker 检查旁边加 command -v curl || { …; exit 10; }');
  });

  // 上面那条 `2>$null` 守卫只证明"没用错写法"，**没有**证明 Invoke-Quiet 真的管用 ——
  // 于是它第一版的 bug 溜了过去（`2>&1` 拦不住 EAP=Stop 升级出来的终止性 NativeCommandError，
  // 见 _devnet-common.ps1 里的说明）。静态守卫必须配一条真跑一遍的行为测试。
  //
  // 用 `cmd /c "echo boom 1>&2 & exit 3"` 而不是 docker：它同样是"写 stderr + 退出码非零"
  // 的原生命令，但不依赖 Docker 是否装了、是否在跑。
  test('Invoke-Quiet 确实吞掉原生命令的 stderr 且不中断脚本（需要 Windows PowerShell）', (t) => {
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (process.platform !== 'win32' || !existsSync(shell)) {
      t.skip('非 Windows，或找不到 Windows PowerShell 5.1');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'karmachain-quiet-'));
    try {
      const probe = join(dir, 'probe.ps1');
      writeFileSync(probe, [
        `. '${join(SCRIPTS, '_devnet-common.ps1')}'`,
        '$r = Invoke-Quiet { cmd /c "echo boom 1>&2 & exit 3" }',
        "if ($null -eq $r) { Write-Host 'RESULT=NULL' } else { Write-Host 'RESULT=GOT' }",
        "Write-Host 'REACHED-END'",
        '',
      ].join('\r\n'), 'ascii');

      const r = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe],
        { encoding: 'utf8' });

      assert.match(r.stdout, /RESULT=NULL/, `失败应返回 $null，实际 stdout：\n${r.stdout}`);
      // 这一条是关键：第一版 bug 下脚本在此之前就被终止了，这行永远打不出来。
      assert.match(r.stdout, /REACHED-END/,
        'Invoke-Quiet 让调用方脚本中止了 —— 它的语义是"探一下，失败就算了"，不该抛出。\n'
        + `stderr：\n${r.stderr}`);
      assert.equal(r.stderr.trim(), '',
        `stderr 泄漏到了控制台：\n${r.stderr}\n`
        + '  跨机形态下脚本会遍历 active.env 里全部 7 个节点 id，每轮轮询有 6 个必然失败 ——\n'
        + '  泄漏的话启动过程会被刷屏，真正的失败被埋掉。');
      assert.equal(r.status, 0, `探针脚本应正常结束，实际退出码 ${r.status}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `_` 开头的公共件两侧都排除：它们不是用户入口，配对与否无契约意义
  // （而 _devnet-common.sh / .ps1 恰好成对，靠它们碰巧对上不算证明）。
  test('每个 .sh 都有同名 .ps1，反之亦然（契约要求等价薄封装）', () => {
    const shNames = readdirSync(SCRIPTS)
      .filter((f) => f.endsWith('.sh') && !f.startsWith('_'))
      .map((f) => f.replace(/\.sh$/, '')).sort();
    const psNames = ps1Files.filter((f) => !f.startsWith('_')).map((f) => f.replace(/\.ps1$/, '')).sort();
    assert.deepEqual(psNames, shNames,
      `.sh 与 .ps1 不成对：\n  只有 .sh：${shNames.filter((n) => !psNames.includes(n)).join(', ') || '（无）'}`
      + `\n  只有 .ps1：${psNames.filter((n) => !shNames.includes(n)).join(', ') || '（无）'}`);
  });
});
