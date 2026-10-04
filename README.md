# family-vault

A tiny, dependency-free, self-hosted **encrypted family information store** — the kind of
data you never want to paste into a chat window (ID numbers, phone numbers, licence plates,
passport numbers, bank cards), but sometimes need to look up from your phone.

* One Node.js file, **zero npm dependencies**.
* Data lives in a single **AES-256-GCM** encrypted file; the key is kept separately and,
  on Windows, wrapped by **DPAPI** so the files are useless if copied to another machine.
* A small dark-mode web UI to view/edit records (auto-saves).
* A **token API** so local programs (chat agents, scripts) can fetch a single value and
  forward it to you — **without the value ever entering the program's own logs or context**.
* Look people up by **name or by appellation** (爸爸 / 妈妈 / 小姨 / ...), with ambiguity
  detected instead of guessed.
* No password, no accounts, no sessions: the only gate is a **network allow/deny policy**
  evaluated on the real peer address reported by your reverse proxy.

> ⚠️ **This repository contains code only. Never commit `data/`, `config.json`, keys or
> tokens.** See [SECURITY.md](SECURITY.md) and run `scripts/check-no-data.ps1` before pushing.

---

## Quick start

```bash
git clone <this repo> family-vault
cd family-vault
cp config.example.json config.json     # edit if you want different ports/paths
node vault-server.mjs
```

Open <http://127.0.0.1:8791/> — the vault is created automatically on first start
(empty), and records you add are encrypted immediately. That's it.

Requirements: Node.js 18+ (uses `node:net` BlockList and `node:crypto` AES-GCM).
Windows is required **only** for `keyMode: "dpapi"`.

## Configuration

`config.json` (git-ignored; relative paths resolve against its own directory):

| key | default | meaning |
|---|---|---|
| `bind` | `127.0.0.1` | listen address. **Keep it on loopback** and put a proxy in front. |
| `port` | `8791` | listen port |
| `dataFile` | `./data/vault.dat` | encrypted vault (safe to back up, useless without the key) |
| `keyFile` | `./data/vault.key` | DPAPI blob (Windows) or raw key (other OS) |
| `tokenFile` | `./data/api-token.txt` | token required by `/api/index` and `/api/lookup` |
| `uiFile` | `./ui.html` | web UI |
| `keyMode` | `auto` | `auto` = DPAPI on Windows, raw key file elsewhere; or force `dpapi` / `file` |
| `trustProxy` | `false` | trust `X-Forwarded-For` / `X-Forwarded-Proto` — **only** if a proxy you control overwrites them |
| `access.autoInit` | `true` | create an empty vault on first start |
| `access.allowCidrs` | `[]` | sources allowed to use the web UI. Empty = no IP filtering (rely on bind). |
| `access.denyIps` | `[]` | sources refused, **takes precedence over the allow list** |

`access` is evaluated on the peer address seen by the server. With `trustProxy: true` that
is the first entry of `X-Forwarded-For`; `tailscale serve`, nginx and Caddy overwrite that
header with the real client address, so a client cannot spoof it (verified — see SECURITY.md).

## HTTP API

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/` | network policy | web UI |
| GET | `/api/health` | network policy | `{ ok, initialized, ip }` |
| GET | `/api/state` | network policy | the whole vault (values included) |
| POST | `/api/save` | network policy | `{ ok, saved }` — body `{ "people": [...] }` |
| GET | `/api/index` | `X-Vault-Token` | names, appellations and **field labels only** — never values |
| GET | `/api/lookup?name=&field=` | `X-Vault-Token` | one value (`field` optional ⇒ list of non-empty field labels) |

`name` accepts a person's name **or** an appellation. If several people match, the API
answers `409 { error: "ambiguous", candidates: [...] }` instead of picking one.

Record shape:

```json
{
  "name": "Jane Doe",
  "appellation": "mom,wife",
  "fields": { "ID card": "…", "phone": "…" },
  "notes": "free text"
}
```

`appellation` may hold several aliases separated by `,` `，` `、` `/` or spaces — any of
them resolves to that person.

## Deployment behind a proxy (recommended)

Keep `bind` on `127.0.0.1` and let a proxy provide TLS and device authentication. Two easy
options:

**Tailscale** (tailnet-only HTTPS, no open ports, automatic certificate):

```bash
tailscale serve --bg --https=8443 8791      # https://<machine>.<tailnet>.ts.net:8443/
tailscale funnel status                     # must stay empty - never expose this publicly
```

Then restrict who may talk to the vault:

```json
"access": { "allowCidrs": ["100.64.0.0/10"], "denyIps": ["100.99.99.99"] }
```

**nginx / Caddy** — proxy to `127.0.0.1:8791`, keep `trustProxy: true`, and add TLS +
your own authentication (mTLS, SSO, basic auth). Anything you put in front **must**
set/overwrite `X-Forwarded-For` and `X-Forwarded-Proto`.

### Run it as a service

* **Windows** — `scripts/install-service.ps1` registers an [NSSM](https://nssm.cc/) service:

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/install-service.ps1 -NodePath (Get-Command node).Source
  ```

* **systemd** (Linux):

  ```ini
  [Unit]
  Description=family-vault
  After=network.target

  [Service]
  WorkingDirectory=/opt/family-vault
  Environment=VAULT_CONFIG=/opt/family-vault/config.json
  ExecStart=/usr/bin/node /opt/family-vault/vault-server.mjs
  Restart=always
  User=family-vault

  [Install]
  WantedBy=multi-user.target
  ```

## Clients

`clients/openclaw/` contains a worked example: a pair of PowerShell scripts that let a chat
agent fetch one value and send it straight to the owner's Feishu (Lark) DM, so the value
never appears in the agent's own context. They are examples — adapt the delivery step to
your chat platform.

## Backups

Copy `data/` somewhere safe (it is tiny). A stolen copy is useless without the key file:

* `keyMode: "dpapi"` — the key file only decrypts on the original machine/OS install.
* `keyMode: "file"` — the raw key sits next to the data; protect the directory
  (mode `0600`, encrypted disk) and **never** commit or upload it.

## License

MIT — see [LICENSE](LICENSE).
