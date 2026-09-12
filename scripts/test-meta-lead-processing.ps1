param(
    [string]$PostgreSqlBin = 'C:\Program Files\PostgreSQL\17\bin',
    [string]$TemporaryDirectory = [System.IO.Path]::GetTempPath()
)

# Runs only against a NEW disposable cluster; never reads application DB credentials.
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $TemporaryDirectory ('agentzpro-meta-sql-' + [guid]::NewGuid().ToString('N'))
$dataDirectory = Join-Path $testRoot 'data'
New-Item -ItemType Directory -Path $testRoot | Out-Null
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$started = $false

function Invoke-PostgresTool([string]$Name, [string[]]$Arguments) {
    & (Join-Path $PostgreSqlBin "$Name.exe") @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

try {
    Invoke-PostgresTool 'initdb' @('-D', $dataDirectory, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale')
    Invoke-PostgresTool 'pg_ctl' @('-D', $dataDirectory, '-l', (Join-Path $testRoot 'postgres.log'), '-o', "-h 127.0.0.1 -p $port", '-w', 'start')
    $started = $true
    $bootstrap = Join-Path $testRoot 'bootstrap.sql'
    # Supabase-managed roles/auth objects are simulated; tenancy uses the real migration.
    @'
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
'@ | Set-Content -LiteralPath $bootstrap -Encoding UTF8
    $defaults = Join-Path $testRoot 'defaults.sql'
    # Deliberately permissive starting ACLs prove the migration revokes inherited defaults.
    'alter default privileges in schema public grant all on tables to public, anon, authenticated, service_role;' |
        Set-Content -LiteralPath $defaults -Encoding UTF8
    $sqlFiles = @(
        $bootstrap,
        (Join-Path $repositoryRoot 'supabase/migrations/20260831000000_auth_and_tenancy_foundation.sql'),
        $defaults,
        (Join-Path $repositoryRoot 'supabase/migrations/20260901150000_create_meta_connections.sql'),
        (Join-Path $repositoryRoot 'supabase/migrations/20260902045159_phase_2_lead_webhooks.sql'),
        (Join-Path $repositoryRoot 'supabase/migrations/20260902120000_lead_projects_and_search.sql'),
        (Join-Path $repositoryRoot 'supabase/migrations/20260902130000_lead_status_and_label.sql'),
        (Join-Path $repositoryRoot 'supabase/migrations/20260908131754_harden_meta_lead_processing.sql'),
        (Join-Path $repositoryRoot 'scripts/sql/meta-ad-name-upgrade-fixture.sql'),
        (Join-Path $repositoryRoot 'supabase/migrations/20260909120000_add_meta_ad_name_mapping.sql'),
        (Join-Path $repositoryRoot 'scripts/sql/meta-ad-name-upgrade-assertions.sql')
    )
    foreach ($sqlFile in $sqlFiles) {
        Invoke-PostgresTool 'psql' @('-X', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', $sqlFile)
    }
    Invoke-PostgresTool 'psql' @('-X', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $repositoryRoot 'scripts/sql/meta-ad-concurrency-setup.sql'))
    $workerA = Start-Process -FilePath (Join-Path $PostgreSqlBin 'psql.exe') -ArgumentList @('-X', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $repositoryRoot 'scripts/sql/meta-ad-concurrency-worker-a.sql')) -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 250
    $workerB = Start-Process -FilePath (Join-Path $PostgreSqlBin 'psql.exe') -ArgumentList @('-X', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $repositoryRoot 'scripts/sql/meta-ad-concurrency-worker-b.sql')) -PassThru -WindowStyle Hidden
    if (-not $workerA.WaitForExit(60000)) { Stop-Process -Id $workerA.Id -Force; throw 'Concurrent worker A timed out.' }
    if (-not $workerB.WaitForExit(60000)) { Stop-Process -Id $workerB.Id -Force; throw 'Concurrent worker B timed out.' }
    if ($workerA.ExitCode -ne 0 -or $workerB.ExitCode -ne 0) { throw 'Concurrent PostgreSQL worker failed.' }
    Invoke-PostgresTool 'psql' @('-X', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $repositoryRoot 'scripts/sql/meta-ad-concurrency-assertions.sql'))
    Invoke-PostgresTool 'psql' @('-X', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $repositoryRoot 'scripts/sql/meta-lead-processing-regression.sql'))
    Write-Output 'Meta migration regression tests passed in the disposable PostgreSQL cluster.'
} finally {
    if ($started) { Invoke-PostgresTool 'pg_ctl' @('-D', $dataDirectory, '-m', 'fast', '-w', 'stop') }
    Write-Output "Disposable cluster files and logs: $testRoot"
}


