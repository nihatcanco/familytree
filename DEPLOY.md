# Deploying with Jenkins and Docker

The `Jenkinsfile` builds, tests and deploys the app on a **Windows** Jenkins agent
running **Docker Desktop** (its steps use `bat` and `powershell`; a Linux agent
would need them ported to `sh`). Target architecture:

```
Git repository (this one or your fork)
      │  clone
      ▼
Jenkins (Windows agent, label FAMILYTREE_AGENT_LABEL)
      │  1. docker build    ──▶  familytree:test + familytree:latest
      │  2. run tests       ──▶  familytree:test (API + headless-browser suites) against a
      │                          throwaway postgres:18 container
      │  3. compose up      ──▶  "familytree" project (docker-compose.yml)
      ▼
Docker Desktop (Linux containers, WSL2)
      ├─ app  ── server.py :8000 in the container, published on host port FAMILYTREE_APP_PORT
      └─ db   ── postgres:18, data on the named volume familytree_pgdata
      ▲
      │  plain HTTP (or HTTPS through a reverse proxy, see section 5)
Browsers  ── http://<server>:<port>/
```

The app container serves the site itself. It is **plain HTTP**, so nothing is
encrypted — logins and passwords cross the network in clear text. That's fine on a
trusted LAN; for anything else, see [section 5](#5-https-and-internet-exposure).
The database has no published port; only the app container can reach it.

Docker is the only deployment path: there is no Python, venv or Windows service for
the app on the host. The data lives in the `db` container's `familytree_pgdata`
volume. Deploys only recreate the `app` container; the database is never rewritten
by a deploy.

---

## 1. One-time server prerequisites

Install on the Windows machine that runs the Jenkins agent:

- **Git for Windows** — `git --version`, on the Jenkins service account's `PATH`
- **[Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)**
  with the WSL2 backend (Linux containers, the default). Then:
  - Settings → General → **Start Docker Desktop when you sign in** — and, so it runs
    after a reboot with nobody signed in, either enable auto-login for that account
    or use Docker Desktop's *"Start Docker Desktop when the machine starts"* option
    if your edition has it.
  - Add the **Jenkins service account** to the local `docker-users` group
    (`net localgroup docker-users <account> /add`), then restart the Jenkins service.
    Without this every `docker` step fails with a pipe/permission error.
  - Check from the Jenkins script console or a throwaway job: `docker version`
    and `docker compose version` both work.

No Python, PostgreSQL or web server install is needed on the host.

| Purpose            | Where                                  |
|--------------------|----------------------------------------|
| App + database     | Compose project `familytree`           |
| Database files     | Docker volume `familytree_pgdata`      |
| App logs           | `docker compose -p familytree logs app` |

---

## 2. Jenkins credential

The only secret is the database password:

**Manage Jenkins → Credentials → System → Global credentials → Add Credentials**

- Kind: **Secret text**
- ID: `familytree-postgres-password`
- Secret: an **alphanumeric** password (it is embedded in the connection URL as-is)

Postgres only applies the password when the `familytree_pgdata` volume is first
created, so every deploy re-applies the credential to the `familytree` role
(`sync-db-password.sql`). To change the password, just update the credential and run
a build.

---

## 3. Settings

Everything specific to your server is a Jenkins environment variable, so none of
it lives in the repository. Set them under **Manage Jenkins → System → Global
properties → Environment variables**; each one is optional and takes effect on the
next build.

| Variable | Default | What it sets |
|---|---|---|
| `FAMILYTREE_APP_PORT` | `8000` | Host port the site is published on |
| `FAMILYTREE_APP_BIND` | *(empty: every interface)* | Host IPv4 address to publish on, e.g. `127.0.0.1` behind a reverse proxy on the same machine (section 5) |
| `FAMILYTREE_AGENT_LABEL` | `windows` | Label of the Windows agent with Docker Desktop |
| `FAMILYTREE_SECURE_COOKIES` | `0` | `1` marks the session cookie `Secure` — only once HTTPS is in front |
| `FAMILYTREE_ADMIN_USERNAME` | `admin` | First admin's username — read only while the database has no accounts |
| `FAMILYTREE_ADMIN_PASSWORD` | *(random)* | First admin's password — same; see [below](#first-run-admin-account) |

Global properties apply to every job on that Jenkins, hence the `FAMILYTREE_`
prefix. The port and bind address can also be set as environment variables on the
agent's node properties instead; the agent label can't, since it is needed before
the agent is chosen.

The compose project name (`familytree`) is deliberately not a setting: renaming it
on a running deployment would start the app on a new, empty database volume.

---

## 4. Port and firewall

The app container publishes **`FAMILYTREE_APP_PORT`** (default `8000`); that is
the only host port this stack uses (the database has no published port, and the
test containers run on their own network). Nothing else on the machine may use it —
the Deploy stage fails with the offending process name if something else is
listening there. Check up front (replace `8000` with your port):

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue   # no output = free
netsh int ipv4 show excludedportrange protocol=tcp   # the port must not fall in a reserved range
```

If it is taken, set `FAMILYTREE_APP_PORT` to a free one.

To reach the app from other machines, allow inbound traffic to that port through
Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "familytree HTTP" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
```

---

## 5. HTTPS and internet exposure

`server.py` only speaks plain HTTP. Before exposing the app beyond a trusted LAN:

1. Run an HTTPS reverse proxy (Caddy, nginx, IIS with ARR, …) on the same machine,
   forwarding to `http://127.0.0.1:<FAMILYTREE_APP_PORT>`.
2. Set `FAMILYTREE_APP_BIND=127.0.0.1`, so the plain-HTTP port is only reachable
   from the machine itself, and open the firewall for the proxy's port instead.
3. Set `FAMILYTREE_SECURE_COOKIES=1`. Leave it at `0` while the site is plain
   HTTP: a `Secure` cookie would never be sent back and logins wouldn't stick.

Behind a proxy or Docker's port forwarding the app may see every client as the
same IP, so the login rate limit (8 failures per 5 minutes per IP) then applies to
everyone at once.

---

## 6. The Jenkins pipeline job

**New Item → Pipeline**, e.g. `familytree-deploy`.

- **Pipeline** section:
  - Definition: **Pipeline script from SCM**
  - SCM: **Git**
  - Repository URL: the clone URL of this repository or your fork
  - Credentials: **- none -** for a public repository; add one for a private fork
  - Branches to build: `*/main`
  - Script Path: `Jenkinsfile`
- Save. The `Jenkinsfile` in the repo declares its own trigger (`pollSCM` every ~3 min).

**Build Now** once to do the initial deploy. The first build creates the `db`
container and its volume, then the `app` container; both restart on their own after
a reboot (`restart: unless-stopped`) once Docker Desktop is up.

### First-run admin account

On the very first start with an empty `Users` table, `server.py` prints a generated
admin password **once** to the app log:

```bat
docker compose -p familytree logs app
```

To choose it yourself instead, set `FAMILYTREE_ADMIN_PASSWORD` (section 3) for the
first build only. Jenkins stores global properties in plain text, so remove it once
the account exists.

---

## 7. Optional: webhook instead of polling

If Jenkins is reachable from GitHub:

1. Install the **GitHub** plugin.
2. Repo → **Settings → Webhooks → Add webhook**
   - Payload URL: `http://<jenkins-host>:8080/github-webhook/`
   - Content type: `application/json`
   - Secret: a random string
3. **Manage Jenkins → System → GitHub → Advanced → Shared secrets** → same secret.
4. In `Jenkinsfile`, replace `pollSCM('H/3 * * * *')` with `githubPush()`.

Keep the job building `main` only. Building pull requests on this agent would run
code from anyone who opens one, on a machine with Docker access; GitHub Actions
already tests pull requests (`.github/workflows/tests.yml`).

---

## Notes

- **Disk**: the `familytree:test` image is about 2.3 GB, as it carries headless
  Chromium for the browser test. That layer is only rebuilt when the requirements
  change, and each deploy prunes the previous build's untagged images.
- **Status / logs**: `docker compose -p familytree ps` and
  `docker compose -p familytree logs -f app` (or `db`).
- **Backups**: a scheduled `pg_dump` from inside the db container, e.g. a daily Task
  Scheduler job running in `cmd`:
  `docker exec familytree-db-1 pg_dump -U familytree -Fc familytree > <backup dir>\familytree-%DATE%.dump`
  Restore with
  `docker exec -i familytree-db-1 pg_restore -U familytree -d familytree --clean < <file>`.
  Keep the dumps outside the repository: they contain the whole family tree.
- **Never** run `docker compose -p familytree down -v` on the server: `-v` deletes the
  `familytree_pgdata` volume, i.e. the database. Plain `down` is safe.
- To roll back: `git revert` on `main`, let the next poll deploy it (or re-run an
  older build in Jenkins). The database is unaffected by code rollbacks
  (`schema.sql` is additive — `CREATE TABLE IF NOT EXISTS` only).
