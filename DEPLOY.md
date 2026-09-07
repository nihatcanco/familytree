# Deploying with Jenkins on Windows Server

Target architecture:

```
GitHub (private repo)
      │  clone over SSH (deploy key)
      ▼
Jenkins service (Windows)
      │  1. run tests
      │  2. robocopy code  ──▶  C:\apps\familytree        (data.sqlite left untouched)
      │  3. nssm restart   ──▶  "familytree" service = python server.py 8000
      ▼
server.py  ── listens on 127.0.0.1:8000
      ▲
      │  mod_proxy
Apache HTTP Server  ── port 80/443, public
```

`server.py` binds to `localhost` only, so the outside world reaches the app **only**
through Apache. `htdocs` is not used — Apache is a pure reverse proxy here.

---

## 1. One-time server prerequisites

Install on the Windows box and make sure they're on the **Jenkins service account's** `PATH`:

- **Git for Windows** — `git --version`
- **Python 3** — `python --version` (3.8+; stdlib only, no `pip install` needed)
- **[NSSM](https://nssm.cc/download)** — put `nssm.exe` in a folder on `PATH` (e.g. `C:\tools\`)
- **Apache HTTP Server** with `mod_proxy` + `mod_proxy_http`

Pick folders:

| Purpose            | Path                     |
|--------------------|--------------------------|
| Deployed app       | `C:\apps\familytree`     |
| SSH keys for clone | `C:\jenkins-keys\`       |
| Service logs       | `C:\apps\familytree\logs\` |

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
nssm install familytree "C:\Path\To\python.exe" "C:\apps\familytree\server.py" 8000
nssm set familytree AppDirectory        "C:\apps\familytree"
nssm set familytree AppStdout           "C:\apps\familytree\logs\out.log"
nssm set familytree AppStderr           "C:\apps\familytree\logs\err.log"
nssm set familytree AppRotateFiles      1
nssm set familytree Start               SERVICE_AUTO_START
rem HTTPS is terminated at Apache, so mark the session cookie Secure:
nssm set familytree AppEnvironmentExtra FAMILYTREE_SECURE_COOKIES=1
```

Don't start it yet — it needs `C:\apps\familytree\` to exist with `server.py` and
`data.sqlite`. The first Jenkins build creates both (it seeds `data.sqlite` from the
repo copy only if the file is missing).

### First-run admin account

On the very first start with an empty `Users` table, `server.py` prints a generated
admin password **once** to `logs\out.log`. To choose it yourself instead, set before
the first start:

```bat
nssm set familytree AppEnvironmentExtra FAMILYTREE_SECURE_COOKIES=1 FAMILYTREE_ADMIN_USERNAME=admin FAMILYTREE_ADMIN_PASSWORD=your-strong-password
```

Remove `FAMILYTREE_ADMIN_PASSWORD` from the service env after the account exists.

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

- **`data.sqlite` is committed to the repo** and used only as the first-run seed.
  Deploys never overwrite the live DB (`robocopy /XF data.sqlite`). If you'd rather
  not track a database, rename it to `data.sqlite.seed`, `.gitignore` the real name,
  and update the seed step in `Jenkinsfile`.
- To roll back: `git revert` on `main`, let the next poll deploy it. The DB is
  unaffected by code rollbacks.
- To see what a deploy would change without touching anything, add `/L` to the
  `robocopy` line temporarily.
