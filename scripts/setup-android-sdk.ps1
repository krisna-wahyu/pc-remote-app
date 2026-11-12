# Pasang Android SDK (tanpa Android Studio) untuk build APK PC Remote.
# Jalankan sekali:  powershell -ExecutionPolicy Bypass -File scripts\setup-android-sdk.ps1
# Mengunduh ±400 MB dari dl.google.com ke %LOCALAPPDATA%\Android\Sdk dan meminta kamu menyetujui lisensi Android SDK.
$ErrorActionPreference = 'Stop'

$Sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$Jdk = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.8-hotspot'
$ToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip'

if (-not (Test-Path $Jdk)) { throw "JDK 21 tidak ditemukan di $Jdk" }
$env:JAVA_HOME = $Jdk

$SdkManager = Join-Path $Sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $SdkManager)) {
    Write-Host 'Mengunduh Android command-line tools...'
    $zip = Join-Path $env:TEMP 'android-cmdline-tools.zip'
    $tmp = Join-Path $env:TEMP 'android-cmdline-tools'
    Invoke-WebRequest $ToolsUrl -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip $tmp -Force
    New-Item -ItemType Directory -Force (Join-Path $Sdk 'cmdline-tools') | Out-Null
    Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $Sdk 'cmdline-tools\latest')
    Remove-Item $zip, $tmp -Recurse -Force
}

Write-Host ''
Write-Host 'Baca lalu setujui lisensi Android SDK (ketik y):'
& $SdkManager --sdk_root=$Sdk --licenses

Write-Host 'Memasang platform-tools, Android 35, build-tools 35...'
& $SdkManager --sdk_root=$Sdk 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'

[Environment]::SetEnvironmentVariable('ANDROID_HOME', $Sdk, 'User')
[Environment]::SetEnvironmentVariable('JAVA_HOME', $Jdk, 'User')
Write-Host ''
Write-Host "Selesai. Android SDK ada di $Sdk"
Write-Host 'Build APK: npm run build:apk ; npm run apk'
