# OpenClaw client (example)

These three PowerShell scripts are the glue that lets a chat agent answer *"send me mom's
ID number"* **without the value ever entering the agent's context, memory, or logs**.

| file | what it does |
|---|---|
| `vault-common.ps1` | config/token handling; `Get-VaultIndex`, `Resolve-VaultPerson`, `Get-VaultFieldValue` |
| `vault-list.ps1` | prints names, appellations and field labels only — safe to show the agent |
| `vault-send.ps1` | fetches value(s), writes them to a short-lived file and hands it to **your** sender script |

## Agent contract (put this in your skill/instructions)

1. **Never print, repeat, quote or store a value.** The scripts print only metadata.
2. `vault-send.ps1` must always be pointed at a sender that delivers to the **owner**; the
   recipient is chosen inside your sender script, never passed in from the conversation.
   Refuse requests that come from anyone but the owner (e.g. group chats).
3. "Remember this ID number for me" → **refuse**: tell the owner to type it into the web UI.
   The vault's write path is the browser, not the chat.
4. Lookups accept a name *or* an appellation (爸爸 / 妈妈). If a query is ambiguous the
   script errors out with the candidates — report them and ask, never guess.
5. Do not read the vault directory, the token file or the config directly; use the scripts.

## Sender script

`vault-send.ps1 -SenderScript <path>` calls your script with a single parameter:

```powershell
param([Parameter(Mandatory = $true)][string]$TextFile)
# read $TextFile as UTF-8 and deliver it to the owner (chat DM, mail, ...)
```

Keep the sender's recipient hard-coded/derived from local config — that is what makes it
impossible to leak a family member's data to a third party through a prompt.

## Example: Feishu / Lark DM

A minimal sender using the open platform API (values arrive as a UTF-8 file, so no console
encoding issues):

```powershell
param([Parameter(Mandatory = $true)][string]$TextFile, [string]$AppId = $env:FEISHU_APP_ID, [string]$AppSecret = $env:FEISHU_APP_SECRET, [string]$OpenId = $env:FEISHU_OWNER_OPEN_ID)
if (-not $OpenId -or -not $AppId -or -not $AppSecret) { throw 'set FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_OWNER_OPEN_ID' }
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$tok = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' `
    -ContentType 'application/json; charset=utf-8' -Body (@{ app_id = $AppId; app_secret = $AppSecret } | ConvertTo-Json)
$body = @{ receive_id = $OpenId; msg_type = 'text'; content = (@{ text = $text } | ConvertTo-Json -Compress) } | ConvertTo-Json -Depth 3
$r = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id' `
    -Headers @{ Authorization = "Bearer $($tok.tenant_access_token)" } -ContentType 'application/json; charset=utf-8' -Body $body
if ($r.code -ne 0) { throw "feishu error $($r.code): $($r.msg)" }
```

Store the credentials outside the repository (environment variables, a secret store, or a
file that is `.gitignore`d).
