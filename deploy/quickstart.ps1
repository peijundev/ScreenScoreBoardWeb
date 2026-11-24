#Requires -Version 5.1
<#
.SYNOPSIS
  ScreenScoreBoard 一键部署 / 启动（Windows 白板、一体机）。

.DESCRIPTION
  1. 检测 Node.js 24+；没有时自动下载官方 Node 24 到项目内 .tools\node（无需管理员权限）。
  2. 执行 npm ci 安装依赖。
  3. 执行 npm run build:web 构建前端。
  4. 启动服务，打印管理端 / 显示端 / 局域网地址，默认自动打开管理端。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\quickstart.ps1

.EXAMPLE
  .\deploy\quickstart.ps1 -Port 8080 -AdminPassword "换成你自己的强密码"

.EXAMPLE
  .\deploy\quickstart.ps1 -NoBrowser -NoBuild
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,
  [string]$BindHost = '0.0.0.0',
  [string]$DataDir = '',
  [string]$AdminPassword = '',
  [switch]$NoBuild,
  [switch]$NoDeps,
  [switch]$NoBrowser,
  [switch]$NoNodeInstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "[ok] $Message" -ForegroundColor Green
}

function Get-NodeMajor([string]$Exe) {
  try {
    $value = & $Exe -v 2>$null
  } catch {
    return 0
  }
  if ($value -match '^v(\d+)\.') { return [int]$Matches[1] }
  return 0
}

Write-Step '检查 Node.js（需要 24+）'
$nodeExe = $null
$npmCmd = $null
$toolsDir = Join-Path $Root '.tools'
$localNode = Join-Path $toolsDir 'node\node.exe'
$localNpm = Join-Path $toolsDir 'node\npm.cmd'

$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode) {
  $systemNodeExe = $systemNode.Source
  if ((Get-NodeMajor $systemNodeExe) -ge 24) {
    $nodeExe = $systemNodeExe
    $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npmCmd) {
      $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
    }
    if ($npmCmd) { Write-Ok "使用系统 Node $(& $nodeExe -v)" }
    else { $nodeExe = $null }
  }
}

if (-not $nodeExe -and (Test-Path $localNode) -and ((Get-NodeMajor $localNode) -ge 24)) {
  $nodeExe = $localNode
  $npmCmd = $localNpm
  $env:PATH = (Join-Path $toolsDir 'node') + ';' + $env:PATH
  Write-Ok "使用项目内 Node $(& $nodeExe -v)"
}

if (-not $nodeExe) {
  if ($NoNodeInstall) {
    throw '未找到 Node.js 24+。请先安装 Node.js 24，或去掉 -NoNodeInstall 让脚本自动下载。'
  }
  Write-Step '未找到 Node.js 24+，下载官方 Node 24 到 .tools\node'
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $indexUrl = 'https://nodejs.org/dist/latest-v24.x/'
  $sumsUrl = $indexUrl + 'SHASUMS256.txt'
  $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
  $line = ($sums -split "`r?`n" | Where-Object { $_ -match ('-win-' + $arch + '\.zip$') } | Select-Object -First 1)
  if (-not $line) { throw "无法从 $sumsUrl 找到 Windows $arch 的 Node 24 安装包。" }
  $parts = $line.Trim() -split '\s+'
  $expected = $parts[0].ToLower()
  $file = $parts[1]
  $archive = Join-Path $toolsDir $file
  $url = $indexUrl + $file
  Write-Step "下载 $file"
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  $actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    throw 'Node.js 安装包 SHA-256 校验失败，已删除下载文件。'
  }
  $extracted = Join-Path $toolsDir ([IO.Path]::GetFileNameWithoutExtension($file))
  if (Test-Path $extracted) { Remove-Item $extracted -Recurse -Force }
  Expand-Archive -Path $archive -DestinationPath $toolsDir -Force
  if (Test-Path (Join-Path $toolsDir 'node')) {
    Remove-Item (Join-Path $toolsDir 'node') -Recurse -Force
  }
  Move-Item $extracted (Join-Path $toolsDir 'node')
  Remove-Item $archive -Force
  $nodeExe = $localNode
  $npmCmd = $localNpm
  $env:PATH = (Join-Path $toolsDir 'node') + ';' + $env:PATH
  Write-Ok "Node $(& $nodeExe -v) 已就绪"
}

if (-not $npmCmd -or -not (Test-Path $npmCmd)) {
  throw '未找到 npm。请确认 Node.js 24+ 安装完整。'
}

if (-not $NoDeps) {
  Write-Step '安装依赖（npm ci）'
  & $npmCmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
  Write-Ok '依赖安装完成'
}

if (-not $NoBuild) {
  Write-Step '构建前端（npm run build:web）'
  & $npmCmd run build:web
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
  Write-Ok '前端构建完成'
}

$displayHtml = Join-Path $Root 'public\v2\display.html'
if (-not (Test-Path $displayHtml)) {
  throw '缺少 public\v2\display.html，请先运行 npm run build:web。'
}

if (-not $DataDir) { $DataDir = Join-Path $Root 'data' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$env:PORT = [string]$Port
$env:HOST = $BindHost
$env:NODE_ENV = 'production'
$env:DATA_DIR = (Resolve-Path $DataDir).Path
if ($AdminPassword) { $env:ADMIN_PASSWORD = $AdminPassword }

$adminUrl = "http://localhost:$Port/admin"
$displayUrl = "http://localhost:$Port/display"
$lanIp = $null
try {
  $lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress
} catch {
  try {
    $lanIp = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.IPAddressToString.StartsWith('127.') } |
      Select-Object -First 1 |
      ForEach-Object { $_.IPAddressToString }
  } catch { }
}

Write-Host ''
Write-Host 'ScreenScoreBoard 已准备启动' -ForegroundColor White
Write-Host "  管理端：$adminUrl"
Write-Host "  显示端：$displayUrl"
if ($lanIp) {
  Write-Host "  局域网：http://${lanIp}:$Port/admin"
}
Write-Host "  数据目录：$env:DATA_DIR"
if ($AdminPassword) {
  Write-Host '  已提供 ADMIN_PASSWORD：首次启动会自动创建管理员。'
} else {
  Write-Host '  首次使用：在本机打开管理端创建管理员（网页初始化只接受本机访问）。'
}
Write-Host '  按 Ctrl+C 停止服务。'
Write-Host ''

if (-not $NoBrowser) {
  $openScript = "Start-Sleep -Seconds 2; Start-Process '$adminUrl'"
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $openScript | Out-Null
}

& $nodeExe (Join-Path $Root 'server\index.js')
exit $LASTEXITCODE
