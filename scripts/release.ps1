# Publie une nouvelle version d'AstralSwitch.
#
#   npm run release -- 0.2.0 "Ce qui change dans cette version"
#
# 1. met le numéro de version partout (package.json, tauri.conf.json, Cargo.toml)
# 2. compile l'installeur signé avec la clé privée (~\.tauri\astralswitch.key)
# 3. prépare le dossier release\v<version> avec les 2 fichiers à déposer sur GitHub :
#      - AstralSwitch_<version>_x64-setup.exe
#      - latest.json   (lu par les applications installées pour savoir qu'une mise à jour existe)

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$keyPath = Join-Path $env:USERPROFILE ".tauri\astralswitch.key"

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version invalide '$Version' (attendu : 1.2.3)" }
if (-not (Test-Path $keyPath)) { throw "Clé de signature introuvable : $keyPath" }

function Set-Version([string]$file, [string]$pattern, [string]$replacement) {
    $path = Join-Path $root $file
    $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    # Seule la 1re occurrence (ex. Cargo.toml : la version du paquet, pas celles des dépendances)
    $new = ([regex]$pattern).Replace($text, $replacement, 1)
    [IO.File]::WriteAllText($path, $new, $utf8)
}

Write-Host "==> Version $Version" -ForegroundColor Cyan
Set-Version "package.json" '"version":\s*"[^"]+"' "`"version`": `"$Version`""
Set-Version "src-tauri\tauri.conf.json" '"version":\s*"[^"]+"' "`"version`": `"$Version`""
Set-Version "src-tauri\Cargo.toml" '(?m)^version\s*=\s*"[^"]+"' "version = `"$Version`""

$conf = Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$endpoint = $conf.plugins.updater.endpoints[0]
if ($endpoint -match 'GITHUB_USER') { throw "Renseigne ton pseudo GitHub dans src-tauri\tauri.conf.json (plugins.updater.endpoints)" }
$repoUrl = $endpoint -replace '/releases/latest/download/latest\.json$', ''

Write-Host "==> Compilation signée" -ForegroundColor Cyan
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Push-Location $root
try { npm run tauri build; if ($LASTEXITCODE -ne 0) { throw "La compilation a échoué" } }
finally { Pop-Location }

$exeName = "AstralSwitch_${Version}_x64-setup.exe"
$bundle = Join-Path $root "src-tauri\target\release\bundle\nsis"
$exe = Join-Path $bundle $exeName
$sig = "$exe.sig"
if (-not (Test-Path $sig)) { throw "Signature absente ($sig)" }

$out = Join-Path $root "release\v$Version"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $exe $out -Force

$latest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content $sig -Raw).Trim()
            url       = "$repoUrl/releases/download/v$Version/$exeName"
        }
    }
}
[IO.File]::WriteAllText((Join-Path $out "latest.json"), ($latest | ConvertTo-Json -Depth 5), $utf8)

Write-Host ""
Write-Host "==> Prêt : $out" -ForegroundColor Green
Write-Host "Sur GitHub : $repoUrl/releases/new"
Write-Host "  - Tag      : v$Version"
Write-Host "  - Fichiers : $exeName  +  latest.json"
Write-Host "  - Publier (pas en brouillon, pas en pré-version)"
