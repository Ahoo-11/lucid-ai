# Connects AI agents to Lucid. By default, the ones on this computer: Claude Code and Hermes Agent.
#   irm __LUCID_ENDPOINT__/connect.ps1 | iex
# Setup links in Lucid add what to connect instead, and Lucid fills in its settings:
#   ?for=project&ai=<provider>   the agent in this folder, through Lucid's proxy: adds to its .env
#   ?for=tracing                 the agent in this folder, by OpenTelemetry: adds to its .env
#   ?for=openclaw&ai=<provider>  OpenClaw: saves settings for it to merge into its config
# It asks you to approve in your browser, then sets things up. No key to copy.
# Run it again any time to reconnect or update.
# Only some agents: $env:LUCID_AGENTS = "hermes" before running it.
# Don't open a browser: $env:LUCID_NO_BROWSER = "1"
# Windows PowerShell 5.1 or later; plain ASCII so any console shows it.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $setupFor = '__LUCID_FOR__'
  # What to write, from Lucid; the key slot in it becomes the key you approve.
  $envLines = @'
__LUCID_ENV__
'@
  $openclawSettings = @'
__LUCID_OPENCLAW__
'@

  function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

  # Runs a program and keeps its output, without stderr warnings stopping the script.
  function Run([string]$exe, [string[]]$arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & $exe @arguments 2>&1 | Out-String
      [pscustomobject]@{ ok = ($LASTEXITCODE -eq 0); out = $out.Trim() }
    } finally {
      $ErrorActionPreference = $previous
    }
  }

  function Post([string]$path, $body) {
    Invoke-RestMethod -Method Post -Uri "$endpoint$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
  }

  try {
    $endpoint = if ($env:LUCID_ENDPOINT) { $env:LUCID_ENDPOINT.TrimEnd('/') } else { '__LUCID_ENDPOINT__' }
    $hermesDir = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
    # The same home folder Node uses, so Claude Code's helper and its settings agree.
    $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $label = "$env:COMPUTERNAME"

    $agents = @()
    if ($setupFor -eq 'agents') {
      if ($env:LUCID_AGENTS) {
        $agents = @($env:LUCID_AGENTS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      } else {
        if ((Test-Path (Join-Path $userHome '.claude')) -or (Has 'claude')) { $agents += 'claude-code' }
        if ((Test-Path $hermesDir) -or (Has 'hermes')) { $agents += 'hermes' }
      }

      # Claude Code's hooks run Lucid's small Node.js helper.
      if ($agents -contains 'claude-code') {
        # Read "v22.13.0" rather than pass node a script: Windows PowerShell 5.1
        # drops the quotes inside arguments it hands to programs.
        $nodeOk = $false
        if (Has 'node') {
          $version = (Run 'node' @('--version')).out
          $nodeOk = $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18
        }
        if (-not $nodeOk) {
          Write-Host 'Found Claude Code, but connecting it needs Node.js 18 or newer: https://nodejs.org'
          $agents = @($agents | Where-Object { $_ -ne 'claude-code' })
        }
      }
      if ($agents.Count -eq 0) { throw 'no Claude Code or Hermes Agent found on this computer. For other agents, follow the setup in Lucid.' }
      $labels = @{ 'claude-code' = 'Claude Code'; 'hermes' = 'Hermes Agent' }
      $what = "$(($agents | ForEach-Object { $labels[$_] }) -join ' and ') on $env:COMPUTERNAME"
    } elseif ($setupFor -eq 'openclaw') {
      # OpenClaw may run commands in a sandbox of their own, where its config isn't.
      if (-not ((Test-Path (Join-Path $userHome '.openclaw')) -or (Has 'openclaw'))) { throw 'no OpenClaw found here. If this terminal runs in a separate sandbox, run it where OpenClaw itself runs.' }
      $agents = @('openclaw')
      $what = "OpenClaw on $env:COMPUTERNAME"
    } else {
      $agents = @('project')
      $folder = Split-Path -Leaf (Get-Location).Path
      $what = "the agent in $folder"
      $label = "$folder on $env:COMPUTERNAME"
    }

    Write-Host "Lucid: connecting $what..."

    try {
      $start = Post '/api/links/start' @{ machine = $label; os = 'Windows'; agents = [string[]]$agents }
    } catch {
      $detail = $null
      try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { }
      if ($detail) { throw $detail }
      throw "couldn't reach $endpoint. Check the address and your connection."
    }

    Write-Host ''
    Write-Host '  Approve this in your browser:'
    Write-Host "    $($start.url)" -ForegroundColor Green
    Write-Host ''
    Write-Host "  Check that the page shows the code $($start.userCode)."
    Write-Host ''
    if (-not $env:LUCID_NO_BROWSER) { try { Start-Process $start.url } catch { } }
    Write-Host 'Waiting for your approval (up to 10 minutes)...'

    $key = $null
    for ($i = 0; $i -lt 320 -and -not $key; $i++) {
      Start-Sleep -Seconds 2
      $answer = $null
      try { $answer = Post '/api/links/poll' @{ deviceCode = $start.deviceCode } } catch { }
      if (-not $answer) { continue }
      if ($answer.status -eq 'approved') { $key = $answer.key; $answered = $answer }
      elseif ($answer.status -eq 'denied') { throw 'the request was declined in Lucid.' }
      elseif ($answer.status -eq 'expired' -or $answer.status -eq 'claimed') { throw 'the code expired. Run this again for a new one.' }
    }
    if (-not $key) { throw 'no approval after 10 minutes. Run this again for a new code.' }
    # Past runs come in only if the person asked for them on the Approve page.
    $historyDays = 0
    if ($answered.historyDays) { $historyDays = [int]$answered.historyDays }
    Write-Host 'Approved.'
    Write-Host ''

    if ($agents -contains 'project') {
      # The folder this runs in is the agent's project. Its other settings stay as they are.
      $envFile = Join-Path (Get-Location).Path '.env'
      $new = @($envLines -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { $_.Replace('__LUCID_KEY__', $key) })
      $names = @($new | ForEach-Object { ($_ -split '=', 2)[0] })
      $kept = @()
      if (Test-Path $envFile) { $kept = @([IO.File]::ReadAllLines($envFile) | Where-Object { $names -notcontains ($_ -split '=', 2)[0].Trim() }) }
      # UTF-8 without a byte-order mark, which would break the first setting.
      [IO.File]::WriteAllLines($envFile, [string[]]($kept + $new))
      Write-Host "- Added to $envFile, with your Lucid key in them:" -ForegroundColor Green
      foreach ($name in $names) { Write-Host "    $name" }
      if ((Has 'git') -and (Run 'git' @('rev-parse', '--is-inside-work-tree')).ok -and -not (Run 'git' @('check-ignore', '-q', '.env')).ok) {
        Write-Host "  .env isn't in .gitignore. Add it there, so your Lucid key isn't committed." -ForegroundColor Yellow
      }
      Write-Host "  The agent's code has to use them; then run the agent once. Where it also runs on a server,"
      Write-Host '  add the same settings to that server''s environment settings.'
    }

    if ($agents -contains 'openclaw') {
      $lucidDir = Join-Path $userHome '.lucid'
      New-Item -ItemType Directory -Force -Path $lucidDir | Out-Null
      $settings = Join-Path $lucidDir 'openclaw.json5'
      [IO.File]::WriteAllText($settings, ($openclawSettings.Trim().Replace('__LUCID_KEY__', $key) + "`n"))
      Write-Host "- OpenClaw: Lucid's settings are in $settings, with your Lucid key in them." -ForegroundColor Green
      Write-Host '  Merge them into ~/.openclaw/openclaw.json, keeping your own key and models, then run: openclaw gateway restart'
    }

    if ($agents -contains 'hermes') {
      $dest = Join-Path $hermesDir 'plugins\lucid'
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      foreach ($file in '__init__.py', 'plugin.yaml') {
        Invoke-WebRequest -UseBasicParsing -Uri "$endpoint/install/hermes/lucid/$file" -OutFile (Join-Path $dest "$file.part")
        Move-Item -Force (Join-Path $dest "$file.part") (Join-Path $dest $file)
      }
      # Settings go in Hermes' own .env, which it loads before plugins. The
      # plugin uploads past chats once, after the restart, then remembers it did.
      $envFile = Join-Path $hermesDir '.env'
      $lines = @()
      if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^(LUCID_ENDPOINT|LUCID_API_KEY|LUCID_BACKFILL_DAYS)=' }) }
      $lines += "LUCID_ENDPOINT=$endpoint", "LUCID_API_KEY=$key"
      if ($historyDays -gt 0) { $lines += "LUCID_BACKFILL_DAYS=$historyDays" }
      # UTF-8 without a byte-order mark, which would break the first setting.
      [IO.File]::WriteAllLines($envFile, [string[]]$lines)
      if ((Has 'hermes') -and (Run 'hermes' @('plugins', 'enable', 'lucid')).ok) {
        Write-Host '- Hermes Agent: connected. Restart Hermes (the gateway or the desktop app) so it loads.' -ForegroundColor Green
      } else {
        Write-Host '- Hermes Agent: plugin installed. Run "hermes plugins enable lucid", then restart Hermes.' -ForegroundColor Green
      }
      if ($historyDays -gt 0) { Write-Host "  After the restart it brings in your last $historyDays days of chats. Lucid shows the progress." }
    }

    if ($agents -contains 'claude-code') {
      $lucidDir = Join-Path $userHome '.lucid'
      New-Item -ItemType Directory -Force -Path $lucidDir | Out-Null
      $cli = Join-Path $lucidDir 'lucid.mjs'
      Invoke-WebRequest -UseBasicParsing -Uri "$endpoint/install/lucid.mjs" -OutFile "$cli.part"
      Move-Item -Force "$cli.part" $cli
      $connected = Run 'node' @($cli, 'connect', 'claude-code', '--endpoint', $endpoint, '--key', $key)
      if (-not $connected.ok) { throw "couldn't update Claude Code's settings: $($connected.out)" }
      Write-Host '- Claude Code: connected. Start a new Claude Code session and it shows up in Lucid.' -ForegroundColor Green
      if ($historyDays -gt 0) {
        # In the background, so this command is done now; Lucid shows the progress.
        # Start-Process joins arguments with spaces, so the path gets its own quotes.
        $arguments = '"{0}" import claude-code --days {1} --endpoint {2} --key {3}' -f $cli, $historyDays, $endpoint, $key
        Start-Process -FilePath (Get-Command node).Source -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $lucidDir 'import.log') -RedirectStandardError (Join-Path $lucidDir 'import-errors.log')
        Write-Host "  Bringing in your last $historyDays days of sessions in the background. Lucid shows the progress."
      }
    }

    Write-Host ''
    Write-Host "Done. See your runs at $endpoint"
  } catch {
    Write-Host ''
    Write-Host "Lucid: $($_.Exception.Message)" -ForegroundColor Red
  }
}
