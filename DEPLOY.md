# Deploying with Jenkins + Docker on Windows Server

Target architecture:

```
GitHub (private repo)
      │  clone over SSH (deploy key)
      ▼
Jenkins (Windows agent, label 'windows')
      │  1. docker build    ──▶  familytree:test + familytree:latest
      │  2. run tests       ──▶  familytree:test against a throwaway postgres:18 container
      │  3. compose up      ──▶  "familytree" project (docker-compose.yml)
      ▼
Docker Desktop (Linux containers, WSL2)
      ├─ app  ── server.py :8000 in the container, published on host port 8000
      └─ db   ── postgres:18, data on the named volume familytree_pgdata
      ▲
      │  plain HTTP
Browsers  ── http://<server>:8000/
```

There is no reverse proxy: the app container serves the site itself on port **8000**
(`APP_PORT` in the `Jenkinsfile`; `docker-compose.yml` uses the same default).
It is **plain HTTP**, so nothing is encrypted — logins and passwords cross the
network in clear text. That's fine on a LAN; for internet exposure, put an HTTPS
proxy (e.g. a Caddy container) in front of it and set `FAMILYTREE_SECURE_COOKIES=1`.
The database has no published port; only the app container can reach it.

Docker is the only deployment path: there is no Python, venv or Windows service for
the app on the host. The data lives in the `db` container's `familytree_pgdata`
volume. Deploys only recreate the `app` container; the database is never rewritten
by a deploy.

---

## 1. One-time server prerequisites

Install on the Windows box:

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
No Python, PostgreSQL install, NSSM or web server (Apache/IIS) is needed on the host.

| Purpose            | Where                                  |
|--------------------|----------------------------------------|
| App + database     | Compose project `familytree`           |
| Database files     | Docker volume `familytree_pgdata`      |
| App logs           | `docker compose -p familytree logs app` |
| SSH keys for clone | `C:\jenkins-keys\`                     |

---

## 2. GitHub deploy key (read-only, this repo only)

On the server:

```bat
mkdir C:\jenkins-keys
ssh-keygen -t ed25519 -f C:\jenkins-keys\familytree_deploy -N ""
```

- GitHub → repo → **Settings → Deploy keys → Add deploy key**
  - Title: `jenkins-windows`
  - Key: paste the contents of `C:\jenkins-keys\familytree_deploy.pub`
  - **Allow write access: unchecked**

---

## 3. Jenkins credentials

**Manage Jenkins → Credentials → System → Global credentials → Add Credentials**, twice:

1. Clone key
   - Kind: **SSH Username with private key**
   - ID: `familytree-deploy-key`
   - Username: `git`
   - Private Key: **Enter directly** → paste contents of `C:\jenkins-keys\familytree_deploy` (no `.pub`)
2. Database password
   - Kind: **Secret text**
   - ID: `familytree-postgres-password`
   - Secret: an **alphanumeric** password (it is embedded in the connection URL as-is)

The database password only takes effect when the `familytree_pgdata` volume is first
created. To change it later, change it inside the database too:
`docker compose -p familytree exec db psql -U familytree -c "ALTER ROLE familytree PASSWORD 'new'"`,
then update the credential.

**Manage Jenkins → Security → Git Host Key Verification Configuration** → **Accept first connection**
(otherwise the first clone fails on an unknown `github.com` host key, because the
service account has no `known_hosts`).

---

## 4. Port and firewall

The app container publishes **port 8000** on every interface; that is the only host
port this stack uses (the database has no published port, and the test containers
run on their own network). Other apps on the box must not use it — the Deploy stage
fails with the offending process name if something else is listening there. Check
up front:

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue   # no output = free
netsh int ipv4 show excludedportrange protocol=tcp   # 8000 must not fall in a reserved range
```

If it does, pick another port and change `APP_PORT` in the `Jenkinsfile` (and the
default in `docker-compose.yml` to match).

Allow inbound traffic to it through Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "familytree HTTP" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
```

Apache is no longer used. If it was only there for this app, stop and disable it
(`Apache2.4` is the default service name — check with `Get-Service *apache*`):

```powershell
Stop-Service Apache2.4
Set-Service  Apache2.4 -StartupType Disabled
```

> `docker-compose.yml` defaults `FAMILYTREE_SECURE_COOKIES` to `0` because the site
> is plain HTTP — a `Secure` cookie would never be sent back and logins wouldn't
> stick. Set it to `1` only once HTTPS is in front of the app.

---

## 5. The Jenkins pipeline job

**New Item → Pipeline**, name `familytree-deploy`.

- **Pipeline** section:
  - Definition: **Pipeline script from SCM**
  - SCM: **Git**
  - Repository URL: `git@github.com:nihatcanco/familytree.git`  *(SSH form, not https)*
  - Credentials: `git (familytree-deploy-key)`
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

To choose it yourself instead, add a `FAMILYTREE_ADMIN_PASSWORD` environment variable
to the Jenkins job (or the agent) for the first build only, and remove it once the
account exists. Skip this if you are migrating existing data (§6) — the accounts
come with it.

---

## 6. One-time migration from the old NSSM + host PostgreSQL setup

Only needed on a box that ran the pre-Docker deploy. While the old `familytree`
Windows service exists, the pipeline's **Retire old service** stage fails the build
until the `familytree_pgdata` volume exists (step 3 creates it), so the app can't come
up on an empty database by accident. Once it does, that stage stops and deletes the
old service itself — if the Jenkins agent account has admin rights. It usually
doesn't (`Access is denied`); then delete it once by hand from an **Administrator**
PowerShell and re-run the build. The build log prints the exact commands; the
service's real name may differ from its display name `familytree`:

```powershell
Get-Service | Where-Object { $_.Name -like '*family*' -or $_.DisplayName -like '*family*' } | Format-Table Name, DisplayName, Status
Stop-Service -Name '<Name>' -Force
sc.exe delete '<Name>'
```

```bat
rem 1. stop the old app service so nothing writes to the host db during the dump
nssm stop familytree

rem 2. dump the live data from the host PostgreSQL
"C:\Program Files\PostgreSQL\18\bin\pg_dump" -U familytree -Fc familytree > C:\backups\familytree-premigration.dump

rem 3. from a checkout of this repo: start only the db container and restore into it
set POSTGRES_PASSWORD=<same value as the familytree-postgres-password credential>
docker compose -p familytree up -d --wait db
docker compose -p familytree exec -T db pg_restore -U familytree -d familytree --no-owner < C:\backups\familytree-premigration.dump
```

Then **Build Now** in Jenkins (it removes the old service and deploys) and check the
site at `http://<server>:8000/`. Once it's confirmed working, delete the old app folder:

```bat
rmdir /s /q C:\apps\familytree
```

and, if nothing else uses it, stop/uninstall the host PostgreSQL service (keep the
dump from step 2). Python and NSSM can be uninstalled too.

---

## 7. Optional: webhook instead of polling

If the Jenkins box is reachable from GitHub:

1. Install the **GitHub** plugin.
2. Repo → **Settings → Webhooks → Add webhook**
   - Payload URL: `http://<jenkins-host>:8080/github-webhook/`
   - Content type: `application/json`
   - Secret: a random string
3. **Manage Jenkins → System → GitHub → Advanced → Shared secrets** → same secret.
4. In `Jenkinsfile`, replace `pollSCM('H/3 * * * *')` with `githubPush()`.

---

## Notes

- **Status / logs**: `docker compose -p familytree ps` and
  `docker compose -p familytree logs -f app` (or `db`).
- **Backups**: a scheduled `pg_dump` from inside the db container, e.g. a daily Task
  Scheduler job:
  `docker exec familytree-db-1 pg_dump -U familytree -Fc familytree > C:\backups\familytree-%DATE%.dump`
  Restore with
  `docker exec -i familytree-db-1 pg_restore -U familytree -d familytree --clean < <file>`.
- **Never** run `docker compose -p familytree down -v` on the server: `-v` deletes the
  `familytree_pgdata` volume, i.e. the database. Plain `down` is safe.
- To roll back: `git revert` on `main`, let the next poll deploy it (or re-run an
  older build in Jenkins). The database is unaffected by code rollbacks
  (`schema.sql` is additive — `CREATE TABLE IF NOT EXISTS` only).
