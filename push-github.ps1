# ============================================================
# 一键把本仓库推送到 GitHub
#   - 令牌只在这一次 push 里用，不会写进 .git/config、不会存盘
#   - 推完会把 origin 设成不带令牌的地址，以后直接 git push 即可（走凭据管理器）
# 用法：
#   .\push-github.ps1                                   # 交互式粘贴令牌
#   .\push-github.ps1 -Token ghp_xxx                    # 直接带令牌
#   .\push-github.ps1 -Repo qw123888/other -Branch main
# ============================================================
param(
  [string]$Repo = "qw123888/fictional-spoon",
  [string]$Branch = "main",
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

Say "=== 电话通知站 → GitHub 推送 ===" "Cyan"
Say "仓库：$Repo    分支：$Branch"
Say ""

# ---------- 1. 拿令牌 ----------
if (-not $Token) {
  Say "请粘贴 GitHub PAT（Personal Access Token），输入时不会显示：" "Yellow"
  try {
    $sec = Read-Host -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    )
  } catch {
    $Token = Read-Host "（当前环境不支持隐藏输入）直接粘贴 PAT"
  }
}
$Token = ($Token -replace "\s", "")
if (-not $Token) { Say "没有令牌，已取消。" "Red"; exit 1 }
if ($Token.Length -lt 20) { Say "令牌看起来太短（$($Token.Length) 位），GitHub PAT 通常 40 位以上。仍继续…" "Yellow" }

# ---------- 2. 提交待推送内容 ----------
$dirty = git status --porcelain
if ($dirty) {
  Say "有未提交的改动，先提交：" "Yellow"
  $dirty | ForEach-Object { Say "  $_" }
  git add -A
  git -c user.name="phone-notify" -c user.email="dev@local" commit -m "本地改动：$(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null
}

# 防呆：把密钥挡在推送之外（排除本脚本自身，里面写着用于匹配的模板串）
Say "扫描将要推送的内容里有没有密钥…"
$leak = git grep --cached -I -E "ak_OxGq|4bfa5219|nl_db7fac|c3da500c|WdEwNzu" -- . ":(exclude)push-github.ps1" ":(exclude)README.md" 2>$null
if ($leak) {
  Say "!! 发现疑似密钥，已中止推送：" "Red"
  $leak | ForEach-Object { Say "   $_" }
  Say "请先移除这些内容（.dev.vars / config.json 应在 .gitignore 里）。" "Red"
  exit 2
}
Say "OK：没有密钥泄漏" "Green"

# ---------- 3. 推送 ----------
Say ""
Say "推送中（第一次推空仓库会创建 main 分支）…" "Cyan"
$url = "https://x-access-token:$Token@github.com/$Repo.git"

# 用内联 URL 推送，避免令牌落到 .git/config
git push $url "HEAD:refs/heads/$Branch"
$code = $LASTEXITCODE

if ($code -ne 0) {
  Say ""
  Say "推送失败（git exit $code）。常见原因：" "Red"
  Say "  · 令牌无效 / 过期 / 没勾 Contents 权限" "Red"
  Say "  · 令牌不是这个仓库的 owner（要 qw123888 名下、或该仓库协作者）" "Red"
  Say "  · 网络被墙：GitHub 域名 DNS 抽风，可在 hosts 里指 20.27.177.113" "Red"
  exit $code
}

# ---------- 4. 收尾 ----------
$plain = "https://github.com/$Repo.git"
git remote remove origin 2>$null | Out-Null
git remote add origin $plain
Say ""
Say "推送成功 ✅" "Green"
Say "仓库地址：https://github.com/$Repo"
Say "origin 已设为：$plain（不含令牌）"
Say ""
Say "下一步：去 Cloudflare 用 Git 连接这个仓库部署，见 README「方式 B」。" "Cyan"
