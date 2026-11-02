# Deploying LuckyBot with Docker Compose

Target: a small single-host deployment (an arm64 Debian 13 box with 4 cores,
~900 MB RAM and a few GB free disk) where LuckyBot runs in Feishu mode and its
Bash tool executes in a separate sandbox container.

This runbook is the operational counterpart to the image sources:

| File | What it is |
| --- | --- |
| `Dockerfile` | Bot image: pnpm build of this repo, Node pinned, runs `node --import tsx src/index.ts`. |
| `deploy/sandbox.Dockerfile` + `deploy/sandbox/` | Sandbox image: Debian + sshd, one user, no forwarding. |
| `deploy/docker-compose.yml` | Both services, networks, limits, mounts. |
| `deploy/docker-compose.override.example.yml` | Optional: put the DB and workspace on specific filesystems. |
| `deploy/sandbox-exec` | Wrapper installed in the bot image; `runtime.shell`/`readFile`/`writeFile` call it. |
| `deploy/larkbot-entrypoint.sh` | Optional "refuse to create an empty DB" guard. |
| `deploy/firewall.sh` + `deploy/larkbot-firewall.service` | Host firewall for the sandbox subnet, plus a 5-minute `--check` timer. |

Run every compose command **from the `deploy/` directory**. That is what makes
`deploy/.env` (and therefore a `docker-compose.override.yml`) take effect: an
explicit `-f` flag on the command line disables `COMPOSE_FILE`.

## 1. Shape of the deployment

```text
host (Debian 13, arm64)
├── magpie gateway            127.0.0.1:3425        (pre-existing)
├── docker
│   ├── larkbot   network_mode: host,           no published ports
│   │             mem 512m, cpus 1, pids 256, oom_score_adj 300
│   │             user 1000:1000, read_only, tmpfs /tmp/cahciua 24m + /tmp 64m
│   │             /app/data          -> volume larkbot-data (or a bind)
│   │             /app/config.yaml   -> ../config.yaml            (ro)
│   │             /app/prompts/IDENTITY.md   -> ../prompts/ID...  (ro)
│   │             ~/.ssh/id_sandbox  -> ../.config/sandbox_key    (ro, 0600)
│   │             ~/.ssh/known_hosts -> ../.config/sandbox_known_hosts (ro)
│   │
│   └── sandbox   bridge sandbox-net 172.31.250.0/24, dns 1.1.1.1/8.8.8.8
│                 127.0.0.1:2222 -> 2222/tcp only
│                 mem 192m, cpus 1, pids 64, oom_score_adj 500
│                 read_only, cap_drop ALL, no-new-privileges
│                 /home/sandbox/work -> volume sandbox-work
│                 /etc/ssh/host_keys -> volume sandbox-host-keys
│                 authorized_keys    -> ../.config/sandbox_authorized_keys (ro)
└── iptables DOCKER-USER + INPUT: sandbox -> LAN/host blocked, internet allowed
    (plus an ip rule skipping a host TUN proxy when BYPASS_TUN=1)
```

The bot talks to the sandbox as `sandbox@127.0.0.1:2222` because it shares the
host network namespace; nothing on the LAN can reach port 2222.

## 2. Prerequisites

- Docker with Compose v2+ (`docker compose version`), root or a `docker` group
  member.
- The repository checked out on the host. This runbook uses `/srv/larkbot`;
  substitute your path everywhere.
- `iptables`, `iproute2` and `systemd` for the sandbox firewall.
- An ssh client on whichever machine builds/administers the deployment
  (`ssh-keygen` for key setup, `ssh` for the transfer in 2.1).

### 2.1 Build where?

Preferred: **build off-host** on an amd64 machine with buildx (arm64 emulation)
and transfer the images — the deployment host never needs a C toolchain, its
disk only holds the images, and `docker compose up` never rebuilds:

```sh
# on the build machine, in the repository
git submodule update --init   # plugins/ (LuckyBot-Plugin) is baked into the image
docker buildx build --platform linux/arm64 -t larkbot:arm64 --load .
docker buildx build --platform linux/arm64 -f deploy/sandbox.Dockerfile -t larkbot-sandbox:arm64 --load deploy/
docker save larkbot:arm64 larkbot-sandbox:arm64 | gzip -1 | \
  ssh root@host 'gunzip | docker load'
# then on the host, tag them for the compose files:
sudo docker tag larkbot:arm64 larkbot:local
sudo docker tag larkbot-sandbox:arm64 larkbot-sandbox:local
```

Fallback: build on the host with `cd deploy && sudo docker compose up -d
--build`. That needs ~2 GB of builder cache plus the toolchain download; run
`sudo docker builder prune -af` afterwards if disk is tight.

The first build takes a few minutes (native modules compile from source);
later builds reuse the layer cache.

#### Or: let CI build and ship it

`.github/workflows/build-image.yml` builds on every push to `main`, publishes
the image to GHCR, and then ships it to the deployment host over SSH, where it
arrives tagged `larkbot:local` — the tag `deploy/docker-compose.yml` expects.
Nothing needs a toolchain locally and no image crosses your own connection.

The restart stays manual (it is an outward-facing change), so deploying a
merged change is just:

```sh
ssh root@host 'cd /path/to/deploy && docker compose up -d larkbot'
```

Setup, once:

1. On the deployment host, create a key dedicated to this and authorize it:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/gha_deploy -N '' -C 'github-actions-deploy'
   cat ~/.ssh/gha_deploy.pub >> ~/.ssh/authorized_keys
   ```
2. In the repository settings, add:
   - secret `DEPLOY_SSH_KEY_B64` — `base64 -w0 ~/.ssh/gha_deploy` from the host
     (base64 so a stray newline cannot corrupt the key);
   - secret `DEPLOY_HOST_KEY` — the host's pinned key, e.g.
     `ssh-keyscan host | grep ed25519`. Pinning it means the runner never trusts
     an unverified key on first connection;
   - variables `DEPLOY_SSH_HOST`, `DEPLOY_SSH_PORT`, `DEPLOY_SSH_USER`.
3. Leave `DEPLOY_SSH_HOST` unset on a fork: the transfer steps then skip and
   the workflow only publishes to GHCR.

The image transfer is a plain `docker save | gzip | ssh … docker load`; the
host does not need to read the GHCR package, which keeps a registry credential
off the machine.

## 3. One-time setup

### 3.1 Files next to the compose file

`deploy/docker-compose.yml` expects these paths, all relative to the `deploy/`
directory:

| Path | Purpose |
| --- | --- |
| `../config.yaml` | Bot configuration, **including the Feishu `appId`/`appSecret`** (mounted read-only). |
| `../prompts/IDENTITY.md` | Persona (deployment-local, gitignored). |
| `../prompts/<other>.md` | Any further file listed in a chat's `systemFiles`; add one read-only mount per file. |
| `../.config/sandbox_key` | SSH private key the bot uses to reach the sandbox. |
| `../.config/sandbox_key.pub` | Its public half (not mounted). |
| `../.config/sandbox_authorized_keys` | Same public key, root-owned; mounted into the sandbox. |
| `../.config/sandbox_known_hosts` | Pinned sandbox host key; mounted into the bot. |

Create `config.yaml` from `config.example.yaml` and put the Feishu credentials
in it (`feishu.appId`, `feishu.appSecret`, optional `feishu.domain`). Do not
commit it: `config.yaml` is gitignored, and since these are the same trust
level as the model API keys and the Telegram token, this file is the only
secret the bot container mounts besides the sandbox SSH key.

The bot container runs as uid 1000 (`node`), so every mounted file must be
readable by that uid:

```sh
cd /srv/larkbot
sudo chown 1000:1000 config.yaml prompts/IDENTITY.md
sudo chmod 600 config.yaml
sudo chmod 644 prompts/IDENTITY.md
```

Deployment-local prompt files are **not** baked into the image (only the
tracked templates are); the persona and any chat policy files arrive through
these mounts. Add a mount per extra `systemFiles` entry, e.g.
`- ../prompts/group-policy.md:/app/prompts/group-policy.md:ro`.

### 3.2 Config values for this deployment

Start from `config.example.yaml`. The deployment-specific values are:

```yaml
platform: "feishu"
feishu:
  appId: "cli_xxxxxxxxxxxxxxxx"
  appSecret: ""
  domain: "feishu"          # "feishu" | "lark" | https:// base URL

models:
  primary:  { apiBaseUrl: "http://127.0.0.1:3425/v1", ... }   # magpie
  probe:    { apiBaseUrl: "http://127.0.0.1:3425/v1", ... }

database:
  path: "./data/cahciua.db"        # -> volume larkbot-data or the bind mount

runtime:
  shell:     ["/usr/local/bin/sandbox-exec", "shell"]
  writeFile: ["/usr/local/bin/sandbox-exec", "write"]
  readFile:  ["/usr/local/bin/sandbox-exec", "read"]
```

`tools.bash.enabled` (per chat, default true) is what exposes the Bash tool. In
this deployment its commands, file writes and file reads all go through
`runtime.*` above, i.e. the sandbox. Without the Docker deployment the default
`/bin/bash -c` runs commands with the bot process's own filesystem access, so a
host Bash tool must not be enabled against real group input.

The wrapper also honours `SANDBOX_SSH_HOST`, `SANDBOX_SSH_PORT`,
`SANDBOX_SSH_USER`, `SANDBOX_SSH_KEY` and `SANDBOX_KNOWN_HOSTS`; the defaults
match this compose file, so no environment is needed.

### 3.3 SSH key pair for the sandbox

```sh
cd /srv/larkbot
mkdir -p .config
ssh-keygen -t ed25519 -N '' -C larkbot-sandbox -f .config/sandbox_key
cp .config/sandbox_key.pub .config/sandbox_authorized_keys
chmod 600 .config/sandbox_key
chmod 644 .config/sandbox_authorized_keys
# The bot runs as uid 1000 (node) and must own its private key...
sudo chown 1000:1000 .config/sandbox_key
# ...while authorized_keys must be readable by the sandbox sshd as the
# unprivileged `sandbox` user (uid 1000), which reads it before authentication:
# root:root 0644 is the simplest option that satisfies StrictModes.
sudo chown root:root .config/sandbox_authorized_keys
```

### 3.4 Host firewall (install it before the sandbox starts)

The sandbox may reach the internet (including DNS, but only through the public
resolvers in the compose `dns:` list) and nothing else: no LAN, no Tailscale
(`100.64.0.0/10`), no link-local (including cloud metadata), no loopback, no
Docker gateway, no host service.

```sh
cd /srv/larkbot
sudo ./deploy/firewall.sh                # idempotent
sudo ./deploy/firewall.sh --check        # exit 0 only if every rule is present

# Persist across reboots, apply before Docker starts, and re-check every 5 min:
sudo install -m 0755 deploy/firewall.sh /usr/local/sbin/larkbot-firewall
sudo install -m 0644 deploy/larkbot-firewall.service /etc/systemd/system/larkbot-firewall.service
sudo install -m 0644 deploy/larkbot-firewall-check.service /etc/systemd/system/larkbot-firewall-check.service
sudo install -m 0644 deploy/larkbot-firewall-check.timer /etc/systemd/system/larkbot-firewall-check.timer
sudo install -m 0644 deploy/larkbot-firewall.env.example /etc/default/larkbot-firewall
sudo systemctl daemon-reload
sudo systemctl enable larkbot-firewall larkbot-firewall-check.timer
```

The firewall unit runs `Before=docker.service`, so the rules normally exist
before any container starts; `ExecStartPost` runs `--check`. It is deliberately
not required by Docker (a firewall error must not stop unrelated containers):
instead, when the five-minute check fails it stops the sandbox container. All
settings are validated before any rule is touched. `/etc/default/larkbot-firewall` is
the place for `SUBNET`, `DNS_RESOLVERS`, `ALLOW_PROXY`, `BYPASS_TUN`,
`BYPASS_TUN_PREF` and `NO_TUN`; **the script itself reads that file** too, so a
manual `sudo larkbot-firewall --check` sees the same settings as the unit, and
an environment variable overrides the file. Every rule carries the comment
`larkbot-sandbox:<generation>` (a hash of the settings). Applying inserts the
new generation first and then deletes the older ones, so the drops are never
absent and changing a setting never leaves a stale ACCEPT behind; `--check`
reports stale generations. The script assumes one sandbox per host: cleanup
removes every `larkbot-sandbox:` rule. The timer logs loudly on failure:

```sh
sudo systemctl status larkbot-firewall-check.service
journalctl -u larkbot-firewall-check.service -n 50
```

Docker's nftables firewall backend does not traverse `DOCKER-USER`; the script
refuses to run when `/etc/docker/daemon.json` or dockerd's unit
(`systemctl cat docker`) selects it, and warns if the chain is missing while
Docker is running.

**Mandatory verification** — run this after the first start, after any Docker
daemon or network change, and whenever `--check` reports a problem. Everything
except the first command must fail (a DROP rule makes curl time out, `exit=28`):

```sh
cd /srv/larkbot/deploy
sudo docker compose exec -T sandbox curl -fsS -m 10 https://example.com >/dev/null && echo "egress ok"
sudo docker compose exec -T sandbox getent hosts example.com && echo "dns ok"
sudo docker compose exec -T sandbox curl -sS -m 5 http://192.168.1.1/          ; echo "exit=$? (LAN, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://192-168-1-1.nip.io/   ; echo "exit=$? (LAN via a host proxy, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://127.0.0.1.nip.io:3425/; echo "exit=$? (host loopback via a host proxy, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://172.31.250.1/         ; echo "exit=$? (host gateway, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://100.64.0.1/           ; echo "exit=$? (Tailscale, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://169.254.169.254/      ; echo "exit=$? (metadata, must fail)"
```

Replace `192.168.1.1`/`192-168-1-1` with the host's actual LAN address. The
`nip.io` rows are the ones that catch a transparent proxy bypass (section 3.8);
on a host without such a proxy they fail for the ordinary reason, and on a host
with one they only pass until Option A or B is applied, so run this list again
after doing so.

If you relocate the network, update the subnet in both files:

```sh
cd /srv/larkbot/deploy
sed -i 's|172.31.250.0/24|10.99.0.0/24|' docker-compose.yml   # then: docker compose down && up -d
cd /srv/larkbot
SUBNET=10.99.0.0/24 sudo -E ./deploy/firewall.sh
```

DNS resolvers are shared with the firewall: the `dns:` list in
docker-compose.yml and `DNS_RESOLVERS` (in `/etc/default/larkbot-firewall` or
the environment, default `1.1.1.1 8.8.8.8`) must agree, because port 53 is
dropped for every other destination. On hosts in mainland China the public
resolvers above are often unreliable without a proxy; set both to a local
public resolver instead (for example `223.5.5.5` in the `dns:` list and
`DNS_RESOLVERS="223.5.5.5"`), and keep the two lists in sync.

### 3.5 First start of the sandbox and host-key pinning

If you built off-host, the images are already loaded (`up -d` will not
rebuild); if you are building on the host, add `--build`.

```sh
cd /srv/larkbot/deploy
sudo docker compose up -d sandbox          # add --build only for an on-host build
sudo docker compose logs sandbox          # "Server listening on ... port 2222"

# Build known_hosts from the sandbox's own public key (no TOFU), then pin it:
host_key=$(sudo docker compose exec -T sandbox cat /etc/ssh/host_keys/ssh_host_ed25519_key.pub)
printf '[127.0.0.1]:2222 %s\n' "$host_key" > ../.config/sandbox_known_hosts
chmod 644 ../.config/sandbox_known_hosts

# The fingerprint must match:
ssh-keygen -lf ../.config/sandbox_known_hosts
sudo docker compose exec -T sandbox ssh-keygen -lf /etc/ssh/host_keys/ssh_host_ed25519_key.pub
```

The host key lives in the `larkbot_sandbox-host-keys` volume, so it survives
`up --force-recreate`, restarts and reboots. If you ever delete that volume,
regenerate `sandbox_known_hosts` the same way before starting the bot.

### 3.6 Where the data lives

By default the SQLite database is the named volume `larkbot_larkbot-data` and
the sandbox workspace is `larkbot_sandbox-work`. To put either on a specific
filesystem, use the override example:

```sh
cd /srv/larkbot/deploy
cp docker-compose.override.example.yml docker-compose.override.yml
cp .env.example .env                     # sets COMPOSE_FILE=...override.yml
# edit the paths, create the directories (a SUBDIRECTORY of the filesystem,
# never its mount point), then make them writable by uid 1000:
sudo mkdir -p /srv/larkbot/data /srv/larkbot/sandbox-work
sudo chown 1000:1000 /srv/larkbot/data /srv/larkbot/sandbox-work
sudo docker compose up -d
```

Notes:

- `create_host_path: false` makes compose fail if the path is missing, instead
  of creating a root-owned directory the container cannot write.
- Use a **subdirectory** of the target filesystem so a failed mount cannot
  silently fall back to the host's root filesystem.
- The filesystem must be ext4-like (XFS/ext4): SQLite WAL needs working
  locking and mmap, and NFS/SMB are not supported.
- With data on secondary/removable storage, make Docker wait for the mount:

  ```sh
  sudo systemctl edit docker.service
  # [Unit]
  # RequiresMountsFor=/srv/larkbot
  ```

- The sandbox workspace is deliberately separate from the DB: give it its own
  filesystem (or a size-limited ext4 image) so a runaway command cannot fill
  the disk holding the database.
- When an existing deployment migrates to this layout, uncomment
  `LARKBOT_REQUIRE_EXISTING_DB: "1"` in the override (the file explains it):
  the entrypoint then refuses to start if `database.path` does not exist,
  instead of silently creating an empty database.

### 3.7 Start everything

```sh
cd /srv/larkbot/deploy
sudo docker compose up -d               # add --build only for an on-host build
sudo docker compose ps
sudo docker compose logs -f larkbot
```

### 3.8 Transparent proxy on the host

If the host runs a TUN-based transparent proxy in fake-IP mode (mihomo, clash,
sing-box, …), the sandbox's traffic is decided **by the host, not by
`firewall.sh`**, and the firewall silently becomes ineffective:

- the sandbox's DNS queries are hijacked; names resolve to fake addresses in
  `198.18.0.0/15`, and `DOCKER-USER` never sees `192.168.x.x` or `127.0.0.1`;
- the proxy dials the real target from the host, *after* the firewall has
  already accepted the connection, so a name such as `127.0.0.1.nip.io` or
  `192-168-3-1.nip.io` reaches the host's loopback services (proxy controller,
  magpie/LLM gateway) and the LAN.

The **nip.io rows in the mandatory verification (3.4) are the test** for this:
on a clean host they fail because the address is dropped, and on a bypassed
host they succeed. Pick one of the three options below.

#### Option A — route the sandbox around the TUN (recommended)

```sh
# 1. Look at the proxy's own rules; the bypass preference must be lower.
ip rule show

# 2. Add the bypass (firewall.sh does this when BYPASS_TUN=1):
sudo ip -4 rule add from 172.31.250.0/24 lookup main pref 8999

# 3. Point the sandbox at resolvers it can reach without the proxy (they must
#    stay in sync; port 53 is only allowed to these addresses):
#    docker-compose.yml: dns: [1.1.1.1, 8.8.8.8]
#    /etc/default/larkbot-firewall: DNS_RESOLVERS="1.1.1.1 8.8.8.8"

# 4. Re-run the checks and the mandatory nip.io verification from 3.4.
sudo ./deploy/firewall.sh --check
```

`firewall.sh` manages that rule when `BYPASS_TUN=1` (preference
`BYPASS_TUN_PREF`, default `8999`): the rule is added, checked by `--check`
and removed by `--remove` together with the iptables rules. It refuses to run
if that preference is already taken by a different rule, so it cannot clobber
the proxy's own configuration.

#### Option B — bypass the TUN *and* add a filtered proxy

Option A already makes the firewall authoritative for direct traffic. On top of
it you can route the Bash tool through a filtering proxy, so commands that
honour `HTTP(S)_PROXY` take a single, auditable egress path that also refuses
private destinations:

```sh
# 0. Option A must be in place: BYPASS_TUN=1 — or NO_TUN=1 on a host that has
#    no transparent proxy at all. ALLOW_PROXY refuses to apply without one of
#    them, because the proxy environment confines nothing by itself.
#    /etc/default/larkbot-firewall
BYPASS_TUN=1

# 1. Allow exactly one address:port through the firewall. Put the proxy's
#    listener on the sandbox bridge gateway so the LAN cannot reach it:
ALLOW_PROXY=172.31.250.1:3128

# 2. Point the Bash tool at it (docker-compose.override.yml — create it from
#    the example first if you have not, see 3.6; `environment` merges with the
#    service's existing entries). It applies to shell commands only, not to
#    readFile/writeFile:
#    services.larkbot.environment
SANDBOX_HTTP_PROXY=http://172.31.250.1:3128
SANDBOX_NO_PROXY=localhost,127.0.0.1,.internal

cd /srv/larkbot/deploy && sudo docker compose up -d
sudo systemctl restart larkbot-firewall larkbot-firewall-check.timer
sudo /usr/local/sbin/larkbot-firewall --check
```

The proxy is a **policy layer, not a confinement**: a sandbox command can
ignore the environment variable and connect directly. That is safe only because
Option A keeps direct traffic under the firewall; do not rely on the proxy
alone to block private addresses.

`ALLOW_PROXY` inserts a single ACCEPT for `tcp` from the sandbox subnet to
exactly that address and port, ahead of the private-range drops: in `INPUT`
when the address is inside `$SUBNET` or otherwise host-local (the bridge
gateway is both, and classifying by subnet also covers the boot order, where the
unit runs before the bridge exists), and in `DOCKER-USER` otherwise. It is
included in `--check` and `--remove`. Binding the listener to `172.31.250.1`
rather than `0.0.0.0` keeps it unreachable from the LAN even before the firewall
is considered.

**The proxy must still enforce the destination policy for the traffic it
carries.** Whatever software is used, its rule set has to:

1. resolve the requested name first, so a name that points at a private
   address is judged by its address rather than its text;
2. then **reject** connections whose resolved destination is in `127.0.0.0/8`,
   `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`,
   `169.254.0.0/16`, `0.0.0.0/8` or `224.0.0.0/4` (and the IPv6 equivalents);
3. allow everything else, or a vetted allow-list;
4. never let the client override the destination or the decision.

A short illustrative snippet (mihomo syntax, **example only** — adapt it to
your proxy and keep the semantics of 1–4 above):

```yaml
rules:
  # judge by the resolved address, not the hostname text
  - IP-CIDR,127.0.0.0/8,REJECT,no-resolve
  - IP-CIDR,10.0.0.0/8,REJECT,no-resolve
  - IP-CIDR,172.16.0.0/12,REJECT,no-resolve
  - IP-CIDR,192.168.0.0/16,REJECT,no-resolve
  - IP-CIDR,100.64.0.0/10,REJECT,no-resolve
  - IP-CIDR,169.254.0.0/16,REJECT,no-resolve
  - MATCH,DIRECT
```

Verification — the firewall governs direct access, the proxy adds a second
check for tools that use it:

```sh
cd /srv/larkbot/deploy
# Direct: private destinations must fail (Option A is authoritative)…
sudo docker compose exec -T sandbox curl -sS -m 5 http://127.0.0.1.nip.io:3425/ ; echo "exit=$? (host loopback, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://192-168-1-1.nip.io/    ; echo "exit=$? (LAN, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://100.64.0.1/            ; echo "exit=$? (Tailscale, must fail)"
sudo docker compose exec -T sandbox curl -sS -m 5 http://169.254.169.254/       ; echo "exit=$? (metadata, must fail)"
# …public egress works, directly and through the proxy:
sudo docker compose exec -T sandbox curl -fsS -m 10 https://example.com >/dev/null && echo "direct egress ok"
sudo docker compose exec -T sandbox curl -x http://172.31.250.1:3128 -fsS -m 10 https://www.google.com >/dev/null && echo "proxy egress ok"
# …and through the proxy the private destinations must fail as well:
sudo docker compose exec -T sandbox curl -x http://172.31.250.1:3128 -sS -m 5 http://127.0.0.1.nip.io:3425/ ; echo "exit=$? (host loopback via proxy, must fail)"
sudo docker compose exec -T sandbox curl -x http://172.31.250.1:3128 -sS -m 5 http://192-168-1-1.nip.io/    ; echo "exit=$? (LAN via proxy, must fail)"
```

#### Option C — proxy-side REJECT for the sandbox subnet

If the TUN cannot be bypassed at all (no Option A/B), add
explicit REJECT rules in the proxy configuration for traffic originating from
the sandbox subnet to the private ranges listed in Option B, and keep the
`nip.io` verification in 3.4 as the acceptance test. Do not treat this as
stronger than Options A/B: the host proxy still dials, so only its own rules
stand between the sandbox and the LAN.

#### Auto-redirect/tproxy caveat

Beware of TUN setups that use **auto-redirect/tproxy** rather than fake-IP:
forwarded traffic is redirected to a local port, so the sandbox's egress is
delivered to a host-local process and the `INPUT` DROP rules here would kill
*all* sandbox traffic (including legitimate internet access). Check before
deploying:

```sh
ip rule show
sudo nft list ruleset | grep -iE 'redirect|tproxy'
```

If either shows proxy redirection for forwarded traffic, use Option A (or
Option B with the proxy bound to the sandbox gateway), then confirm
`https://example.com` (or another external site) still works from inside the
sandbox.

## 4. Day-to-day

```sh
cd /srv/larkbot/deploy

# Logs (json-file driver, rotated at 3 x 10 MB):
sudo docker compose logs -f --tail=200 larkbot
sudo docker compose logs --tail=200 sandbox

# Restart / stop without touching volumes:
sudo docker compose restart larkbot
sudo docker compose down                  # keeps volumes

# The Bash tool's route, end to end:
sudo docker compose exec -T larkbot /usr/local/bin/sandbox-exec shell 'id; pwd; ls -a'

# Firewall state (the timer also runs this every 5 minutes):
sudo /usr/local/sbin/larkbot-firewall --check; echo "check exit=$?"
```

## 5. Update

### 5.1 Off-host build (default)

```sh
# build machine
docker buildx build --platform linux/arm64 -t larkbot:arm64 --load .
docker save larkbot:arm64 | gzip -1 | ssh root@host 'gunzip | docker load'
# host
cd /srv/larkbot/deploy && sudo docker compose up -d
```

### 5.2 On-host build (fallback)

```sh
cd /srv/larkbot/deploy
sudo docker compose stop larkbot
sudo docker compose cp larkbot:/app/data ../pre-update-data   # optional snapshot
cd /srv/larkbot
sudo git pull
cd deploy
sudo docker compose up -d --build
sudo docker builder prune -af             # reclaim the build cache
```

The app applies Drizzle migrations on startup; migrations are forward-only, so
a code rollback may also need a database restore (section 6).

## 6. Backup and rollback

State that matters: the SQLite database (and background-task output), plus
`config.yaml`, `.config/` (the sandbox SSH key and pinned host key) and
`prompts/*.md` on the host.

A SQLite database is only consistent together with its `-wal` and `-shm`
siblings, so either stop the bot or take an in-process snapshot:

```sh
cd /srv/larkbot/deploy
mkdir -p ../backup

# Option A — in-process snapshot while the bot keeps running (uses the
# better-sqlite3 that is already in the image; no sqlite3 CLI needed):
sudo docker compose exec -T -e SNAP=backup-$(date +%F).db larkbot node --input-type=module <<'EOF'
import Database from "better-sqlite3";
const target = `/app/data/${process.env.SNAP}`;
new Database("/app/data/cahciua.db", { readonly: true }).exec(`VACUUM INTO '${target}'`);
console.log("snapshot written:", process.env.SNAP);
EOF
sudo docker compose cp larkbot:/app/data/backup-$(date +%F).db ../backup/
sudo docker compose exec -T larkbot rm /app/data/backup-$(date +%F).db

# Option B — stop, copy the whole directory (including -wal/-shm), restart:
sudo docker compose stop larkbot
sudo docker compose cp larkbot:/app/data ../backup/data-$(date +%F)
sudo docker compose start larkbot

sudo cp -a ../config.yaml ../.config ../prompts ../backup/
```

Restore:

```sh
cd /srv/larkbot/deploy
sudo docker compose stop larkbot
sudo docker compose cp ../backup/data-<date>/. larkbot:/app/data/

# `docker cp` writes files as root, and the image drops all capabilities, so
# fix ownership with a throwaway container (this works while the bot is
# stopped; `exec` would not):
sudo docker compose run --rm --no-deps -u 0 --cap-add CHOWN \
  --entrypoint chown larkbot -R 1000:1000 /app/data

git checkout <previous-commit-or-tag>
sudo docker compose up -d
```

With the bind-mount override (3.6) the data directory is on the host, so
`sudo chown -R 1000:1000 /srv/larkbot/data` does the same thing without
starting a container.

Never copy a single `cahciua.db` out of a running deployment without its
`-wal`/`-shm` files, and never leave root-owned files inside `/app/data`: the
next write fails with `EACCES`. A host `sqlite3
/srv/larkbot/data/cahciua.db ".backup /srv/larkbot/backup/cahciua.db"` is also
consistent for the bind-mount layout.

`docker compose down` never removes the named volumes; only an explicit
`docker volume rm larkbot_larkbot-data` does. The same is true for the sandbox
volumes (and deleting `larkbot_sandbox-host-keys` invalidates the pinned
`known_hosts`, see 3.5).

## 7. Security model

What the sandbox can do:

- run arbitrary shell commands, read/write `/home/sandbox/work` (volume
  `sandbox-work`), reach the public internet, and resolve DNS through the
  configured public resolvers;
- see only its own container: a Debian userland, the mounted `authorized_keys`,
  and the host key volume. It has no view of the bot's config, Feishu
  credentials, SQLite database, prompts, or SSH private key, and no host mounts
  at all besides the read-only `authorized_keys` file.

What it cannot do — **provided the host has no transparent proxy, or the
`BYPASS_TUN` rule or a filtered proxy (3.8) is in place**:

- reach the host's LAN, Tailscale (`100.64.0.0/10`), link-local (including
  `169.254.169.254`), loopback, the Docker gateway or any host service
  (`firewall.sh`, IPv4 only; compose gives `sandbox-net` no IPv6);
- resolve or connect to anything on those networks: port 53 is allowed only to
  the public resolvers in the compose `dns:` list;
- accept passwords, root logins, sftp, agent/X11/TCP/stream-local forwarding or
  tunnels — one user, one key, `AuthenticationMethods publickey`,
  `DisableForwarding yes`;
- gain privileges: `read_only` root filesystem, `cap_drop: [ALL]` with only
  `SETUID`/`SETGID`/`CHOWN`/`SYS_CHROOT`/`AUDIT_WRITE` added back for sshd,
  `no-new-privileges`, no setuid binaries in the image.

A fake-IP TUN proxy on the host breaks the first two guarantees regardless of
this configuration, because the host proxy dials on the sandbox's behalf; the
`nip.io` checks in 3.4 are the test for it. With Option B (3.8) the guarantees
depend on the proxy's own destination rules, which the firewall cannot
inspect; with Option A they stay with this configuration.

How the Bash tool talks to it (all in `deploy/sandbox-exec`):

- commands run over SSH with a PTY, so the kernel kills a timed-out command's
  whole process group when the bot's connection dies (no orphan keeps burning
  the sandbox CPU); `stty raw` keeps the PTY from rewriting output bytes, and
  `TERM=dumb`/`NO_COLOR` keep programs from colourising output for a terminal
  that is not a human;
- the script is passed to `bash -c` as an argument, not on stdin, so a command
  that reads stdin cannot consume the rest of it; stdin itself is `/dev/null`,
  which is what the Bash tool provides anyway;
- `readFile`/`writeFile` use a PTY-less connection and a fixed remote helper
  (`sandbox-fs read|write <base64-path>`), whose paths are canonicalized and
  confined to `/home/sandbox/work` — `..`, absolute paths outside the work
  directory and symlinks pointing out of it are rejected; absolute paths
  inside it are accepted. This confinement is hygiene against accidents, not a
  security boundary: the shell mode is arbitrary code execution inside the
  container by design, and the container is the boundary;
- exit status and stdout/stderr pass through unchanged (stdout and stderr share
  the PTY in shell mode, which is what the Bash tool already merges); an
  unreachable sandbox or a killed connection surfaces as ssh's exit status 255.

The bot container is **not** sandboxed from the host: it uses the host network
namespace on purpose (magpie on `127.0.0.1:3425`) and mounts the Feishu
credentials. Only code paths the bot can be prompted into (the Bash tool and
its file readers/writers) are pushed into the sandbox. The bot itself runs
read-only, without capabilities and as uid 1000.

Secrets on the host and where they end up:

| Secret | Host location (mode/owner) | Inside containers |
| --- | --- | --- |
| Feishu app secret, model API keys, Telegram token | `config.yaml` (0600, uid 1000) | bot `/app/config.yaml`, read-only |
| Sandbox SSH private key | `.config/sandbox_key` (0600, uid 1000) | bot `~/.ssh/id_sandbox`, read-only |
| Sandbox SSH public key | `.config/sandbox_authorized_keys` (0644, root) | sandbox `/etc/ssh/authorized_keys/sandbox`, read-only |
| Sandbox host key | `larkbot_sandbox-host-keys` volume (0600, root) | sandbox `/etc/ssh/host_keys/`; public half pinned in `.config/sandbox_known_hosts` |

The images contain no credentials and no persona file (only tracked prompt
templates are copied; `prompts/IDENTITY.md` and other deployment-local prompt
files are bind-mounted at runtime). LLM request/response dumps for debugging
are written to `/tmp/cahciua/` inside the bot container (its own 24 MB tmpfs),
one pair per chat, overwritten in place.

Known limits: a container escape (kernel or sshd bug) defeats the sandbox, the
firewall only covers IPv4, and a host transparent proxy bypasses it unless the
`BYPASS_TUN` rule or a filtered proxy is used (3.8). If you enable IPv6 for
`sandbox-net`, add the equivalent `ip6tables` rules.

## 8. Resources

- Bot: `mem_limit 512m`, `memswap_limit 512m`, `cpus 1`, `pids_limit 256`,
  `oom_score_adj 300`, `NODE_OPTIONS=--max-old-space-size=320` (baked into the
  image), `read_only`. `/tmp/cahciua` (24 MB) holds the LLM dumps;
  `/tmp` (64 MB) holds live background-task output (`os.tmpdir()`), which the app does not
  size-cap — keep it generously larger than the biggest expected build/test log.
- Sandbox: `mem_limit 192m`, `cpus 1`, `pids_limit 64`, `oom_score_adj 500`,
  `read_only`, tmpfs `/tmp` (32 MB) and `/run` (8 MB). Raise the `/tmp` size if
  the Bash tool must unpack large packages; that memory counts against the
  container's limit.
- Both containers rotate their logs at 3 x 10 MB through the json-file driver.
- Images (arm64, measured after `docker load`): `docker images` reports ~810 MB
  (bot) and ~384 MB (sandbox); the `docker save` exports are ~175 MB and
  ~85 MB, and the unpacked root trees are ~570 MB and ~280 MB. The build stage
  trims binaries the image can never load (non-Linux `ffprobe-static` builds,
  musl variants of libvips and TDLib) and excludes `*.test.ts`.
- Disk: ~1.2 GB for both images as `docker images` accounts for them, plus the
  builder cache if you build on the host. `docker builder prune -af` after a
  rebuild, or transfer a pre-built image with `docker save | ssh host docker
  load`, keeps a 3-4 GB host comfortable.
- arm64 note: `ffprobe-static` has no linux/arm64 binary, so `animationToText`
  cannot extract frames from video attachments (TGS/Lottie animations and
  images still work). The build drops the unusable binaries.
- TDLib is present (`prebuilt-tdlib` ships arm64 for Debian glibc) but is never
  loaded in Feishu mode: `tdl.configure()` only runs for `platform: telegram`,
  and no ldconfig entry or `vendor/` is needed. The image keeps the glibc TDLib
  binary, so a `platform: telegram` deployment of the same image still works;
  only the musl variants are pruned.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Permission denied (publickey)` in Bash tool results | Key not readable as uid 1000: `sudo chown 1000:1000 .config/sandbox_key && chmod 600 .config/sandbox_key`. Check `sudo docker compose logs sandbox` for the rejection. |
| `bad ownership or modes` in sandbox logs | `authorized_keys` must be owned by root (0644) or by uid 1000: `sudo chown root:root .config/sandbox_authorized_keys && sudo chmod 644 .config/sandbox_authorized_keys`. |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | The sandbox host key was regenerated (volume deleted). Re-run 3.5's public-key pinning. |
| Bot exits immediately with an `ENOENT ... config.yaml` error | `config.yaml` must exist before `up`; Docker creates a *directory* for a missing bind-mount source, which then fails to parse. `sudo docker compose logs larkbot`. |
| Bot exits with `LARKBOT_REQUIRE_EXISTING_DB=1 but the database ... does not exist` | The data mount is missing/empty. Fix the mount or unset the guard (3.6). |
| Bot cannot write the database after a restore (`EACCES`) | `docker cp` writes files as root: `sudo docker compose run --rm --no-deps -u 0 --cap-add CHOWN --entrypoint chown larkbot -R 1000:1000 /app/data` (or `sudo chown -R 1000:1000` on the bind mount). |
| Sandbox cannot resolve names | The `dns:` list and `DNS_RESOLVERS` must match and be reachable; port 53 to anything else is dropped by design (3.4). |
| Sandbox reaches the LAN / `larkbot-firewall --check` fails | Rules missing or Docker uses the nftables backend: re-run `sudo /usr/local/sbin/larkbot-firewall`, read the warning, and verify egress (3.4). |
| Sandbox reaches `127.0.0.1.nip.io` / the LAN only under `nip.io` names | A fake-IP TUN proxy is dialling on the sandbox's behalf; apply 3.8. |
| Sandbox has no internet at all on a proxy host | Auto-redirect/tproxy sends forwarded traffic to a host-local port and the `INPUT` DROP catches it; see 3.8. |
| Model calls fail with connection errors | magpie must be reachable at the configured address from the host network namespace (`curl http://127.0.0.1:3425/v1/models` on the host). |
| Bash tool reports a timeout | The command exceeded the tool's timeout (foreground Bash calls cap at 30 s); a killed SSH connection makes the sandbox hang up the command's process group. If it is a connection error instead, check `docker compose ps` — an unreachable sandbox fails with ssh exit 255. |
| Disk filling up | `sudo docker image prune -f && sudo docker builder prune -af`; keep the log rotation and put the sandbox workspace on its own filesystem (3.6). |
| Bot aborts with a `better-sqlite3` assertion | The Node pin was lost (image rebuilt with Node >= 24.19 headers). Rebuild from this Dockerfile. |
