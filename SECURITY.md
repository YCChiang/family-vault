# Security model

Read this before you deploy. It is short and it is the whole story.

## What protects the data

| Layer | What it does |
|---|---|
| AES-256-GCM | the vault file (`data/vault.dat`) is encrypted; tampering is detected (GCM tag) |
| separate key file | the 256-bit data key is **not** stored in the vault file |
| DPAPI (`keyMode: "dpapi"`) | on Windows the key file is wrapped with `LocalMachine` DPAPI, so it is **not portable** to another machine |
| network policy (`access`) | the only gate for the web UI, evaluated on the peer address |
| API token (`X-Vault-Token`) | required by `/api/index` and `/api/lookup`; stored in `tokenFile` (mode `0600`) |

The vault file alone is useless. Vault file **and** key file copied to another machine:
with DPAPI, still useless; with `keyMode: "file"`, readable — that is the trade-off you
accept by not using Windows.

## What is deliberately **not** there

* No password, no user accounts, no sessions, no cookies, no password reset.
  (An earlier revision had a passphrase; it was removed on purpose. If you want one, put
  it in the proxy in front — reverse-proxy basic auth, mTLS or SSO — rather than in here.)
* No telemetry, no outbound connections, no third-party dependencies.
* No value is ever logged. Errors log the HTTP method, path and error kind only.

## The gate is the network, so treat it that way

1. **Never** bind to `0.0.0.0` without a proxy that authenticates callers.
2. **Never** publish the port to the internet. If you use Tailscale, keep `tailscale funnel`
   off; `tailscale serve` is tailnet-only.
3. `access.denyIps` wins over `access.allowCidrs` — that is how you exclude a single device
   that has access to the network but should not read the vault.
4. `trustProxy` must be `true` **only** when a proxy you control terminates the connection
   and overwrites `X-Forwarded-For`. Otherwise the header is client-controlled and the
   policy can be bypassed. `tailscale serve` overwrites it (a spoofed value is ignored —
   tested).
5. Anyone who can reach the port inside the allowed range can read every value. Choose the
   range accordingly: a tailnet that only your own devices join, or an SSH tunnel.

## Handling values on the way to a human

The point of this project is that lookups can happen **without** the value entering an
LLM's context or a log file. The example client therefore:

* writes the value to a short-lived UTF-8 file under `%LOCALAPPDATA%\...\tmp`, sends it,
  and deletes it immediately (deleting twice: right after the send returns **and** in a
  `finally` block, because `exit` inside `try` skips `finally` in PowerShell);
* purges leftovers older than two minutes on every run;
* the server purges leftovers older than two minutes at startup (belt and braces);
* prints only metadata (`SENT person=… fields=…`), never the value;
* has no recipient parameter, so it cannot be pointed at somebody else.

## Before you push

`scripts/check-no-data.ps1` fails if anything that looks like data, a key, a token or a
real config is present or staged. Run it, or wire it into a pre-commit hook:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-no-data.ps1
```

`.gitignore` already excludes `data/`, `config.json`, `*.dat`, `*.key`, `*.dpapi`,
`api-token.txt`, `tmp/` and logs. Keep it that way: this repository is code only.

## Reporting

This is a personal-scale tool, not an audited product. If you find a flaw, open an issue
(without real data in it) or fix it in a pull request.
