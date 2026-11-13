# Isi secret GitHub Actions dari keystore lokal, supaya APK hasil GitHub ditandatangani kunci release yang sama
# (update di HP bisa langsung menimpa versi lama). Nilai rahasia tidak pernah ditampilkan di layar.
#
# Butuh GitHub CLI yang sudah login:
#   winget install GitHub.cli
#   gh auth login
# Lalu dari folder proyek:
#   powershell -ExecutionPolicy Bypass -File scripts\set-github-secrets.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'keystore'
$propsFile = Join-Path $dir 'keystore.properties'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host 'GitHub CLI (gh) belum terpasang. Jalankan: winget install GitHub.cli lalu gh auth login' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $propsFile)) {
    Write-Host "Tidak menemukan $propsFile" -ForegroundColor Red
    exit 1
}

$props = @{}
foreach ($line in Get-Content $propsFile) {
    if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)$') { $props[$Matches[1]] = $Matches[2].Trim() }
}
foreach ($k in 'storeFile', 'storePassword', 'keyAlias', 'keyPassword') {
    if (-not $props[$k]) { Write-Host "keystore.properties tidak berisi $k" -ForegroundColor Red; exit 1 }
}

$jks = Join-Path $dir $props['storeFile']
if (-not (Test-Path $jks)) { Write-Host "Tidak menemukan file keystore $jks" -ForegroundColor Red; exit 1 }

Push-Location $root
try {
    $secrets = [ordered]@{
        KEYSTORE_BASE64   = [Convert]::ToBase64String([IO.File]::ReadAllBytes($jks))
        KEYSTORE_PASSWORD = $props['storePassword']
        KEY_ALIAS         = $props['keyAlias']
        KEY_PASSWORD      = $props['keyPassword']
    }
    foreach ($name in $secrets.Keys) {
        # Nilai dikirim lewat stdin, tidak muncul di argumen perintah maupun di layar.
        $secrets[$name] | gh secret set $name
        if ($LASTEXITCODE -ne 0) { throw "Gagal mengisi secret $name" }
        Write-Host "OK  $name" -ForegroundColor Green
    }
    Write-Host ''
    Write-Host 'Selesai. Push berikutnya (atau "Run workflow" di tab Actions) akan menghasilkan APK bertanda tangan release.'
} finally {
    Pop-Location
}
