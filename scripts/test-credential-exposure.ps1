param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$patterns = @('META_APP_SECRET','SUPABASE_SERVICE_ROLE_KEY','QSTASH_TOKEN','page_access_token_encrypted','long_lived_user_access_token_encrypted','access_token=')
$bundleRoot = Join-Path $RepositoryRoot '.next/static'
if (-not (Test-Path $bundleRoot)) { throw 'Production client bundle is missing; run npm run build first.' }
foreach ($pattern in $patterns) {
  $hits = @(rg -l -i --glob '*.js' -- $pattern $bundleRoot 2>$null)
  if ($LASTEXITCODE -eq 0 -and $hits.Count -gt 0) { throw "Credential exposure pattern found in client bundle: $pattern" }
}
$sourceFiles = @(rg -l --glob '*.{ts,tsx}' 'console\.(log|warn|error)' (Join-Path $RepositoryRoot 'src') 2>$null)
foreach ($file in $sourceFiles) {
  $secretLog = @(Get-Content -LiteralPath $file | Where-Object { $_ -match 'console\.(log|warn|error)' -and $_ -match '(token|secret|access[_-]?token|authorization|credential)' })
  if ($secretLog.Count -gt 0) { throw "Potential credential-bearing log found in source file: $file" }
}
Write-Output 'Credential exposure scan passed: no forbidden values or credential-bearing logs found.'
