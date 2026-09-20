# tools/test/parse-ps51.ps1 —— 用**运行本脚本的那个 PowerShell** 解析一批 .ps1，报出语法错。
#
# 本仓库的 .ps1 要在**两台 Windows 机器**上跑，而它们装的是 Windows PowerShell 5.1。
# 5.1 与 PowerShell 7 有真实的语法差异（行首 `|` 续行、`&&` / `||` / `??` / 三元），
# 7 能解析的 5.1 未必能 —— 而那种错是**整个脚本解析不了**，不是某一行失败。
#
# 2026-09-20 在 win-2 上实地撞到：`devnet-node.ps1 restart l1-2` 直接 ParserError，
# 而我这边用 pwsh 7 检查一路绿。
#
# 用法：powershell -NoProfile -File tools/test/parse-ps51.ps1 <文件…>
# 输出：每个有错的文件一行 `<路径>|<行>|<消息>`；全部无错时无输出。
# 退出码：0 无错 | 1 有错
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)

$bad = 0
foreach ($p in $Paths) {
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $bad = 1
        foreach ($e in $errors) {
            $line = $e.Extent.StartLineNumber
            Write-Output ("{0}|{1}|{2}" -f $p, $line, $e.Message)
        }
    }
}
exit $bad
