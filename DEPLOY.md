# Deploying with Jenkins on Windows Server

Target architecture:

```
GitHub (private repo)
      │  clone over SSH (deploy key)
      ▼
Jenkins service (Windows)
      │  1. run tests (against a scratch PostgreSQL database)
      │  2. robocopy code  ──▶  C:\apps\familytree
      │  3. sync .venv     ──▶  pip install -r requirements.txt
      │  4. nssm restart   ──▶  "familytree" service = .venv\Scripts\python server.py 8000
      ▼
server.py  ── listens on 127.0.0.1:8000, talks to PostgreSQL on localhost
      ▲
      │  mod_proxy
Apache HTTP Server  ── port 80/443, public
```

`server.py` binds to `localhost` only, so the outside world reaches the app **only**
through Apache. `htdocs` is not used — Apache is a pure reverse proxy here.

The data lives in a local **PostgreSQL** instance (its own Windows service).
Deploys only ever touch code; the database is never rewritten by a deploy.

---

## 1. One-time server prerequisites

Install on the Windows box and make sure they're on the **Jenkins service account's** `PATH`:

- **Git for Windows** — `git --version`
- **Python 3** — `python --version` (3.9+). Dependencies (`psycopg`) install into a
  venv from `requirements.txt`; Jenkins does this automatically.
- **PostgreSQL** — the [EDB Windows installer](https://www.postgresql.org/download/windows/)
  registers it as a service. Put `psql.exe` (e.g. `C:\Program Files\PostgreSQL\17\bin`)
  on `PATH`. See §1a below.
- **[NSSM](https://nssm.cc/download)** — put `nssm.exe` in a folder on `PATH` (e.g. `C:\tools\`)
- **Apache HTTP Server** with `mod_proxy` + `mod_proxy_http`

Pick folders:

| Purpose            | Path                     |
|--------------------|--------------------------|
| Deployed app       | `C:\apps\familytree`     |
| App venv           | `C:\apps\familytree\.venv` |
| SSH keys for clone | `C:\jenkins-keys\`       |
| Service logs       | `C:\apps\familytree\logs\` |

---

## 1a. PostgreSQL setup

After installing PostgreSQL, create the app database and a login role. From an
elevated shell (adjust the `psql` path / version):

```bat
set PGBIN=C:\Program Files\PostgreSQL\17\bin
"%PGBIN%\psql" -U postgres -c "CREATE ROLE familytree LOGIN PASSWORD 'CHANGE-ME';"
"%PGBIN%\psql" -U postgres -c "CREATE DATABASE familytree OWNER familytree;"
```

The connection string the app uses (keep the password in sync):

```
postgresql://familytree:CHANGE-ME@localhost/familytree
```

Also create the scratch database the Jenkins **Test** stage resets on every build
(`TEST_DATABASE_URL` in the `Jenkinsfile`):

```bat
"%PGBIN%\psql" -U postgres -c "CREATE ROLE familytree_test LOGIN PASSWORD 'familytree_test';"
"%PGBIN%\psql" -U postgres -c "CREATE DATABASE familytree_test OWNER familytree_test;"
```

### One-time initial data load

The repo ships `data.sqlite` purely as the seed source. Once, on the server,
load the schema and the current tree into the live database:

```bat
cd C:\apps\familytree
set FAMILYTREE_DATABASE_URL=postgresql://familytree:CHANGE-ME@localhost/familytree
.venv\Scripts\python migrate_sqlite_to_pg.py
```

(`server.py` also applies `schema.sql` itself on every startup, so if you start
with an empty database and enter data through the UI you can skip this.)

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

## 3. Jenkins credential

**Manage Jenkins → Credentials → System → Global credentials → Add Credentials**

- Kind: **SSH Username with private key**
- ID: `familytree-deploy-key`
- Username: `git`
- Private Key: **Enter directly** → paste contents of `C:\jenkins-keys\familytree_deploy` (no `.pub`)

**Manage Jenkins → Security → Git Host Key Verification Configuration** → **Accept first connection**
(otherwise the first clone fails on an unknown `github.com` host key, because the
service account has no `known_hosts`).

---

## 4. The `familytree` Windows service (NSSM)

```bat
rem Runs from the app venv (created by the Jenkins 'Install dependencies' stage):
nssm install familytree "C:\apps\familytree\.venv\Scripts\python.exe" "C:\apps\familytree\server.py" 8000
nssm set familytree AppDirectory        "C:\apps\familytree"
nssm set familytree AppStdout           "C:\apps\familytree\logs\out.log"
nssm set familytree AppStderr           "C:\apps\familytree\logs\err.log"
nssm set familytree AppRotateFiles      1
nssm set familytree Start               SERVICE_AUTO_START
rem HTTPS is terminated at Apache (Secure cookie); point the app at PostgreSQL:
nssm set familytree AppEnvironmentExtra FAMILYTREE_SECURE_COOKIES=1 FAMILYTREE_DATABASE_URL=postgresql://familytree:CHANGE-ME@localhost/familytree
```

Don't start it yet — it needs `C:\apps\familytree\` to exist with `server.py` and
its `.venv`. The first Jenkins build creates both. `server.py` applies `schema.sql`
on startup, so an empty database is fine; run `migrate_sqlite_to_pg.py` (§1a) first
if you want the existing tree.

### First-run admin account

On the very first start with an empty `Users` table, `server.py` prints a generated
admin password **once** to `logs\out.log`. To choose it yourself instead, set before
the first start:

```bat
nssm set familytree AppEnvironmentExtra FAMILYTREE_SECURE_COOKIES=1 FAMILYTREE_DATABASE_URL=postgresql://familytree:CHANGE-ME@localhost/familytree FAMILYTREE_ADMIN_USERNAME=admin FAMILYTREE_ADMIN_PASSWORD=your-strong-password
```

Remove `FAMILYTREE_ADMIN_PASSWORD` from the service env after the account exists
(keep `FAMILYTREE_DATABASE_URL`).

### Let Jenkins restart it

The Jenkins service account must be able to run `nssm restart familytree`. Easiest:
run the Jenkins service as `LocalSystem` (the default) or as a local Administrator.
Otherwise grant that account the "restart" right on the service with `sc sdset` or
a tool like `subinacl`.

---

## 5. Apache reverse proxy

In `httpd.conf` uncomment:

```apache
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
```

Add a vhost (adjust `ServerName`; add TLS with `mod_ssl` / a real cert for production):

```apache
<VirtualHost *:80>
    ServerName familytree.example.com

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/

    ErrorLog  "logs/familytree-error.log"
    CustomLog "logs/familytree-access.log" common
</VirtualHost>
```

`httpd -t` then restart Apache.

> If you serve this over HTTPS, keep `FAMILYTREE_SECURE_COOKIES=1` on the service.
> If you ever run it plain HTTP on a LAN, drop that env var or logins won't stick.

---

## 6. The Jenkins pipeline job

**New Item → Pipeline**, name `familytree-deploy`.

- **Pipeline** section:
  - Definition: **Pipeline script from SCM**
  - SCM: **Git**
  - Repository URL: `git@github.com:nihatcanco/familytree.git`  *(SSH form, not https)*
  - Credentials: `git (familytree-deploy-key)`
  - Branches to build: `*/main`
  - Script Path: `Jenkinsfile`
- Save. The `Jenkinsfile` in the repo declares its own trigger (`pollSCM` every ~3 min).

**Build Now** once to do the initial deploy, then start the service:

```bat
nssm start familytree
```

Check `logs\out.log` for the admin password (if you didn't set one), then browse to
your Apache vhost.

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

- **`data.sqlite` is committed to the repo** and is only the one-time seed source
  for `migrate_sqlite_to_pg.py` (§1a). Nothing reads it at runtime; deploys exclude
  it (`robocopy /XF data.sqlite`).
- **Backups** are now a scheduled `pg_dump`, e.g. a daily Task Scheduler job:
  `"%PGBIN%\pg_dump" -U familytree -Fc familytree > C:\backups\familytree-%DATE%.dump`
  Restore with `pg_restore -U familytree -d familytree --clean <file>`.
- To roll back: `git revert` on `main`, let the next poll deploy it. The database
  is unaffected by code rollbacks (`schema.sql` is additive — `CREATE TABLE IF NOT
  EXISTS` only).
- To see what a deploy would change without touching anything, add `/L` to the
  `robocopy` line temporarily.
