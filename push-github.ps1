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
  [string]$Token = "",
  [switch]$Check
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location -Path $PSScriptRoot

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

# 调 GitHub API，返回 @{code=HTTP状态码; data=对象或错误文本}
function HttpJson($method, $url, $bodyObj) {
  $headers = @{
    Authorization = "Bearer $Token"
    "User-Agent"  = "phone-notify-push"
    Accept        = "application/vnd.github+json"
  }
  try {
    if ($null -ne $bodyObj) {
      $json = $bodyObj | ConvertTo-Json -Compress
      $r = Invoke-RestMethod -Method $method -Uri $url -Headers $headers -Body $json -ContentType "application/json" -TimeoutSec 20
    } else {
      $r = Invoke-RestMethod -Method $method -Uri $url -Headers $headers -TimeoutSec 20
    }
    return @{ code = 200; data = $r }
  } catch {
    $code = 0
    $txt = ""
    $resp = $_.Exception.Response
    if ($resp) {
      try { $code = [int]$resp.StatusCode } catch { $code = 0 }
    }
    # PowerShell 5.1：错误响应体放在 ErrorDetails 里
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $txt = $_.ErrorDetails.Message }
    if (-not $txt -and $resp) {
      try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $txt = $sr.ReadToEnd()
        $sr.Close()
      } catch { $txt = "" }
    }
    if (-not $txt) { $txt = $_.Exception.Message }
    return @{ code = $code; data = $txt }
  }
}

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

# ---------- 1.5 令牌预检（不改动仓库、不产生提交）----------
Say ""
Say "预检令牌…" "Cyan"

$who = HttpJson "GET" "https://api.github.com/user" $null
if ($who.code -ne 200) {
  Say "  令牌无效或已过期（HTTP $($who.code)）：$($who.data)" "Red"
  exit 3
}
Say "  身份：$($who.data.login)（$($who.data.type)）" "Green"
if ($who.data.login -ne ($Repo -split "/")[0]) {
  Say "  !! 注意：令牌属于 $($who.data.login)，而目标仓库属于 $(($Repo -split '/')[0])" "Yellow"
  Say "     只有在你是该仓库协作者时才推得动。" "Yellow"
}

# 用 git/blobs 探针验写权限：只创建一个没人引用的 blob，不留提交、不留分支
$probe = HttpJson "POST" "https://api.github.com/repos/$Repo/git/blobs" @{ content = "permcheck"; encoding = "utf-8" }
if ($probe.code -in @(401, 403, 404)) {
  Say "  写权限：被拒（HTTP $($probe.code)）" "Red"
  Say "  GitHub 说：$($probe.data)" "DarkGray"
  Say ""
  Say "这个令牌没有本仓库的写入权限。去改（30 秒）：" "Yellow"
  Say "  https://github.com/settings/personal-access-tokens" "Yellow"
  Say "  点开这个令牌 → Repository access 选「Only select repositories」并勾上 fictional-spoon" "Yellow"
  Say "  → Permissions → Repository permissions → Contents 改成 Read and write → Save" "Yellow"
  Say "  （如果是 fine-grained 且只能选「Public Repositories」，则新建一个经典令牌：" "Yellow"
  Say "    https://github.com/settings/tokens/new?scopes=repo&description=phone-notify ）" "Yellow"
  Say ""
  Say "改完重新运行本脚本即可。想看新令牌行不行：.\push-github.bat -Check" "Yellow"
  exit 3
}

if ($probe.code -eq 201) {
  Say "  写权限：OK（Contents: Read and write）" "Green"
} else {
  Say "  写权限：OK（HTTP $($probe.code)）" "Green"
}

if ($Check) {
  Say ""
  Say "预检通过，令牌可用（-Check 模式，没有推送任何东西）。" "Green"
  exit 0
}

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
$ErrorActionPreference = "Continue"   # git 会往 stderr 写进度/报错，别让它当成异常炸掉
$pushOut = git push $url "HEAD:refs/heads/$Branch" 2>&1 | Out-String
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($code -ne 0) {
  Say ""
  Say "git 输出：" "DarkGray"
  ($pushOut.Trim() -split "`n") | ForEach-Object { Say "  $_" "DarkGray" }
  Say ""
  Say "推送失败（git exit $code）。常见原因：" "Red"
  Say "  · 令牌无效 / 过期 / 没勾 Contents 权限" "Red"
  Say "  · 令牌不是这个仓库的 owner（要 qw123888 名下、或该仓库协作者）" "Red"
  Say "  · 网络被墙：GitHub 域名 DNS 抽风，可在 hosts 里指 20.27.177.113" "Red"
  exit $code
}
($pushOut.Trim() -split "`n") | Select-Object -Last 1 | ForEach-Object { Say "  $_" "DarkGray" }

# ---------- 4. 收尾 ----------
$plain = "https://github.com/$Repo.git"
$ErrorActionPreference = "Continue"   # git 往 stderr 写提示时别炸脚本
git remote remove origin 2>&1 | Out-Null
git remote add origin $plain 2>&1 | Out-Null
$ErrorActionPreference = "Stop"
$nowOrigin = (git remote get-url origin 2>&1 | Out-String).Trim()
if ($nowOrigin -ne $plain) { git remote set-url origin $plain 2>&1 | Out-Null; $nowOrigin = $plain }
Say ""
Say "推送成功 ✅" "Green"
Say "仓库地址：https://github.com/$Repo"
Say "origin = $nowOrigin（不含令牌）"
Say ""
Say "下一步：去 Cloudflare 用 Git 连接这个仓库部署，见 README「方式 B」。" "Cyan"
