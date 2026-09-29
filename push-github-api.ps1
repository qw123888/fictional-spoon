<#
  推送到 GitHub（走 REST API，不依赖 github.com 的 443 直连）
  ------------------------------------------------------------
  为什么需要它：本机到 github.com:443 的连接会被间歇性重置（DNS 抽风/连接重置），
  `git push` 会报 "Authentication failed" 或 "Failed to connect"，但 api.github.com 一直通。
  这个脚本用 Git Data API 把当前 HEAD 的内容推上去：
      blobs → tree → commit → update ref
  用法：
      powershell -ExecutionPolicy Bypass -File push-github-api.ps1 -Token ghp_xxx
      powershell -ExecutionPolicy Bypass -File push-github-api.ps1            # 会安全提示输入令牌
  令牌只需要 classic 的 repo 权限（或 fine-grained 的 Contents: Read and write）。
#>
param(
  [string]$Repo = "qw123888/fictional-spoon",
  [string]$Branch = "main",
  [string]$Token = "",
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Api = "https://api.github.com"

function Fail($msg) {
  Write-Host ""
  Write-Host "推送失败：$msg" -ForegroundColor Red
  exit 1
}

function HttpJson($method, $url, $bodyObj) {
  $headers = @{
    "Authorization" = "token $Token"
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "phone-notify-pusher"
  }
  try {
    if ($null -eq $bodyObj) {
      $resp = Invoke-RestMethod -Uri $url -Method $method -Headers $headers -TimeoutSec 60
    } else {
      $json = $bodyObj | ConvertTo-Json -Depth 12 -Compress
      $resp = Invoke-RestMethod -Uri $url -Method $method -Headers $headers -Body $json -ContentType "application/json; charset=utf-8" -TimeoutSec 120
    }
    return @{ ok = $true; code = 200; data = $resp }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
    return @{ ok = $false; code = $code; data = $msg }
  }
}

Write-Host "=== 电话通知站 → GitHub（REST API 方式）===" -ForegroundColor Cyan
Write-Host "仓库：$Repo    分支：$Branch"

Set-Location $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Token)) {
  $sec = Read-Host "粘贴 GitHub 令牌（输入不回显）" -AsSecureString
  try {
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  } catch {
    $Token = Read-Host "令牌（明文回退）"
  }
}
$Token = $Token.Trim()
if ($Token.Length -lt 20) { Fail "令牌看起来太短（$($Token.Length) 字符），没有推送。" }

# 0) 令牌与写权限预检
Write-Host "预检令牌…"
$me = HttpJson "GET" "$Api/user" $null
if (-not $me.ok) { Fail "令牌无效或被拒（HTTP $($me.code)）：$($me.data)" }
Write-Host "  身份：$($me.data.login)" -ForegroundColor Green

# 1) 本地是否干净 + 有没有未提交改动
$dirty = git status --porcelain
if ($dirty) {
  Write-Host "有未提交的改动，先提交：" -ForegroundColor Yellow
  $dirty -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "  $($_.TrimEnd())" }
  git add -A | Out-Null
  if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "本地改动：" + (Get-Date -Format "yyyy-MM-dd HH:mm")
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $commitOut = (git -c user.name="phone-notify" -c user.email="dev@local" commit -m $Message 2>&1 | Out-String)
  $ErrorActionPreference = $prev
  if ($LASTEXITCODE -ne 0) { Write-Host $commitOut.Trim() -ForegroundColor Yellow }
}

# 2) 密钥泄漏扫描（和 git 方式同一套模式）
Write-Host "扫描将要推送的内容里有没有密钥…"
$prev2 = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$scan = (git grep --cached -I -E "ak_OxGq|ak_ZMvQ|4bfa5219|nl_db7fac|c3da500c|WdEwNzu|ghp_" -- . ":(exclude)push-github.ps1" ":(exclude)push-github-api.ps1" ":(exclude)README.md" 2>&1 | Out-String)
$ErrorActionPreference = $prev2
if ($scan.Trim()) {
  Write-Host $scan.Trim() -ForegroundColor Red
  Fail "检测到疑似密钥，已中止推送。"
}
Write-Host "OK：没有密钥泄漏" -ForegroundColor Green

# 3) 本地 HEAD 与远端 HEAD
$localSha = (git rev-parse HEAD).Trim()
$localMsg = (git log -1 --pretty=%s).Trim()
Write-Host "本地 HEAD：$($localSha.Substring(0,8))  $localMsg"

# 读取用单数 git/ref/...，更新分支必须用复数 git/refs/...（用错会 404）
$refUrl = "$Api/repos/$Repo/git/refs/heads/$Branch"
$ref = HttpJson "GET" $refUrl $null
$parentSha = ""
if ($ref.ok) {
  $parentSha = $ref.data.object.sha
  Write-Host "远端 HEAD：$($parentSha.Substring(0,8))"
} elseif ($ref.code -eq 404) {
  Write-Host "远端分支不存在（首次推送，会创建 $Branch）" -ForegroundColor Yellow
} else {
  Fail "读取远端分支失败（HTTP $($ref.code)）：$($ref.data)"
}
if ($parentSha -eq $localSha) {
  Write-Host "远端已经是最新提交，无需推送 ✅" -ForegroundColor Green
  exit 0
}

# 4) 只上传与远端不同的文件；内容取 HEAD 里的 blob（不是工作区，避免 autocrlf 改写行尾/把未提交内容推上去）
Write-Host "比对与远端不同的文件…"
$remoteBlobs = @{}
if ($parentSha) {
  $rt = HttpJson "GET" "$Api/repos/$Repo/git/trees/$parentSha`?recursive=1" $null
  if ($rt.ok) {
    foreach ($e in $rt.data.tree) { if ($e.type -eq "blob") { $remoteBlobs[$e.path] = $e.sha } }
  }
}
$lines = @(git ls-tree -r HEAD)
if (-not $lines) { Fail "本地 HEAD 里没有文件。" }
$tmp = [IO.Path]::GetTempFileName()
$changed = @()
foreach ($line in $lines) {
  $parts = $line -split "\s+", 4
  $mode = $parts[0]; $sha = $parts[2]; $path = $parts[3]
  if ($remoteBlobs[$path] -ne $sha) { $changed += @{ path = $path; sha = $sha; mode = $mode } }
}
Write-Host "  需要上传：$($changed.Count) 个（远端已有 $($remoteBlobs.Count) 个文件）"
if ($changed.Count -eq 0) {
  Write-Host "远端内容与本地 HEAD 完全一致，无需推送 ✅" -ForegroundColor Green
  exit 0
}

$tree = @()
$i = 0
foreach ($c in $changed) {
  $i++
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  cmd /c "git cat-file blob $($c.sha) > `"$tmp`"" 2>&1 | Out-Null
  $ErrorActionPreference = $prevEap
  $bytes = [IO.File]::ReadAllBytes($tmp)
  $b64 = [Convert]::ToBase64String($bytes)
  $r = HttpJson "POST" "$Api/repos/$Repo/git/blobs" @{ content = $b64; encoding = "base64" }
  if (-not $r.ok) { Fail "上传 $($c.path) 失败（HTTP $($r.code)）：$($r.data)" }
  $tree += @{ path = $c.path; mode = $c.mode; type = "blob"; sha = $r.data.sha }
  Write-Host ("  [{0,2}/{1}] {2}" -f $i, $changed.Count, $c.path)
}
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

# 5) 建 tree（用 base_tree 保留远端已有文件，只覆盖本地这份）
$treeBody = @{ tree = $tree }
if ($parentSha) { $treeBody.base_tree = $parentSha }
$t = HttpJson "POST" "$Api/repos/$Repo/git/trees" $treeBody
if (-not $t.ok) { Fail "建 tree 失败（HTTP $($t.code)）：$($t.data)" }

# 6) 建 commit
if ([string]::IsNullOrWhiteSpace($Message)) { $Message = $localMsg }
$commitBody = @{ message = $Message; tree = $t.data.sha; parents = @() }
if ($parentSha) { $commitBody.parents = @($parentSha) }
$c = HttpJson "POST" "$Api/repos/$Repo/git/commits" $commitBody
if (-not $c.ok) { Fail "建 commit 失败（HTTP $($c.code)）：$($c.data)" }

# 7) 更新分支引用
if ($parentSha) {
  $u = HttpJson "PATCH" $refUrl @{ sha = $c.data.sha; force = $false }
} else {
  $u = HttpJson "POST" "$Api/repos/$Repo/git/refs" @{ ref = "refs/heads/$Branch"; sha = $c.data.sha }
}
if (-not $u.ok) { Fail "更新分支失败（HTTP $($u.code)）：$($u.data)" }

Write-Host ""
Write-Host "推送成功 ✅" -ForegroundColor Green
Write-Host "提交：$($c.data.sha.Substring(0,8))  $Message"
Write-Host "仓库：https://github.com/$Repo"

# 8) 让本地 git 也记住 origin（不含令牌）
$prev3 = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$cur = (git remote get-url origin 2>&1 | Out-String)
$ErrorActionPreference = $prev3
$want = "https://github.com/$Repo.git"
if ($cur.Trim() -ne $want) {
  $prev4 = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  git remote remove origin 2>&1 | Out-Null
  git remote add origin $want 2>&1 | Out-Null
  $ErrorActionPreference = $prev4
}
Write-Host "origin = $want（不含令牌）"
Write-Host "提示：本地 git 里的提交历史与远端是两条并行线（API 推送不改本地 HEAD），下次用 git push 前先 git pull --rebase。" -ForegroundColor DarkGray
