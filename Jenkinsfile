// CI/CD for the family-tree app on a Windows Jenkins agent running Docker
// Desktop (Linux containers).
//
//   GitHub (public)   --clone over HTTPS-->          Jenkins
//   Jenkins           --docker build, test in a throwaway Postgres container-->
//   Jenkins           --docker compose up-->         "familytree" project:
//                                                      app (server.py :8000) + db (postgres:18)
//   Browsers          --plain HTTP-->                 host port 8000 -> app container :8000
//
// The live database is the db service in docker-compose.yml, on the named
// volume familytree_pgdata; deploys only replace the app container. server.py
// creates its schema on startup. See DEPLOY.md for the server and job setup.

pipeline {
  agent { label 'windows' }

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  triggers {
    // Jenkins isn't assumed to be reachable from GitHub, so poll instead of webhook.
    // Swap for `githubPush()` if you set up a webhook (see DEPLOY.md).
    pollSCM('H/3 * * * *')
  }

  environment {
    // Compose project name: fixes container/volume names (familytree_pgdata)
    // no matter which workspace directory the build runs in.
    COMPOSE_PROJECT_NAME = 'familytree'
    // Public host port the site is served on (docker-compose.yml maps it to 8000).
    APP_PORT = '8000'
    // Secret text credential; docker-compose.yml refuses to start without it.
    POSTGRES_PASSWORD = credentials('familytree-postgres-password')
    // Per-build names for the Test stage's throwaway database.
    TEST_NET = "familytree-test-${env.BUILD_NUMBER}"
    TEST_PG  = "familytree-test-pg-${env.BUILD_NUMBER}"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Stamp version') {
      // Rewrite version.json so the app footer can show the Jenkins build
      // number. 'Build image' copies it into the image as-is; the repo's
      // committed version.json (build "dev") is only for local runs.
      //
      // Also cache-bust every asset the browser fetches by URL, by appending
      // "?v=<build>": the two entries index.html loads directly (css/app.css,
      // js/app.js) AND every `./*.js` ES module specifier inside js/*.js
      // (app.js imports api.js/tree-model.js/icons.js/util.js/card-view.js/
      // tour.js; card-view.js and tour.js import further from there) -- each
      // is its own browser-cached fetch, independent of how the importing
      // file was loaded, so all of them need the same treatment or a deploy
      // can end up running a fresh app.js against a stale helper module.
      // server.py already sends Cache-Control: no-cache on every static file,
      // but browsers (and any proxy between them and the server) aren't
      // guaranteed to honor that header -- a changed URL forces a fresh fetch
      // regardless of what any in-between cache does with the headers.
      steps {
        powershell '''
          $build = $env:BUILD_NUMBER
          $stamp = [ordered]@{ build = $build } | ConvertTo-Json -Compress
          [System.IO.File]::WriteAllText("$env:WORKSPACE\\version.json", $stamp)
          Write-Host "version.json -> $stamp"

          $indexPath = "$env:WORKSPACE\\index.html"
          $html = [System.IO.File]::ReadAllText($indexPath)
          $html = $html -replace 'href="css/app\\.css"', "href=`"css/app.css?v=$build`""
          $html = $html -replace 'src="js/app\\.js"', "src=`"js/app.js?v=$build`""
          [System.IO.File]::WriteAllText($indexPath, $html)
          Write-Host "index.html -> cache-busted css/app.css and js/app.js with build $build"

          Get-ChildItem "$env:WORKSPACE\\js" -Filter *.js | ForEach-Object {
            $original = [System.IO.File]::ReadAllText($_.FullName)
            $updated = [regex]::Replace($original, "from '\\./([a-zA-Z0-9_-]+)\\.js'", "from './`$1.js?v=$build'")
            if ($updated -ne $original) {
              [System.IO.File]::WriteAllText($_.FullName, $updated)
              Write-Host "$($_.Name) -> cache-busted its ./*.js imports with build $build"
            }
          }
        '''
      }
    }

    stage('Build image') {
      steps {
        bat '''
          docker build --pull --target test -t familytree:test . || exit /b 1
          docker build --target app -t familytree:latest . || exit /b 1
        '''
      }
    }

    stage('Test') {
      // API integration test, run inside the test image against a throwaway
      // postgres:18 container (tmpfs, own network) that only lives for this
      // stage. pg_fixture resets and seeds it; the live db is never touched.
      steps {
        powershell '''
          docker network create $env:TEST_NET
          if ($LASTEXITCODE) { exit 1 }
          docker run -d --name $env:TEST_PG --network $env:TEST_NET --tmpfs /var/lib/postgresql `
            -e POSTGRES_USER=familytree -e POSTGRES_PASSWORD=familytree -e POSTGRES_DB=familytree_test `
            postgres:18
          if ($LASTEXITCODE) { exit 1 }

          # -h 127.0.0.1 so the image's unix-socket-only init server doesn't count as ready.
          $ready = $false
          for ($i = 0; $i -lt 30; $i++) {
            docker exec $env:TEST_PG pg_isready -q -h 127.0.0.1 -U familytree -d familytree_test
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep 2
          }
          if (-not $ready) { docker logs --tail 30 $env:TEST_PG; exit 1 }

          docker run --rm --network $env:TEST_NET `
            -e "TEST_DATABASE_URL=postgresql://familytree:familytree@$($env:TEST_PG):5432/familytree_test" `
            familytree:test
          if ($LASTEXITCODE) { exit 1 }
        '''
      }
      post {
        always {
          bat '''
            docker rm -f %TEST_PG% >nul 2>&1
            docker network rm %TEST_NET% >nul 2>&1
            exit /b 0
          '''
        }
      }
    }

    stage('Deploy') {
      // Starts db if it isn't running (first deploy creates the pgdata volume)
      // and recreates app on the freshly built familytree:latest. --wait blocks
      // until both report healthy, or fails the stage.
      steps {
        // Other apps share this box: refuse to deploy if anything but our own
        // app container is already listening on APP_PORT, and name the culprit.
        powershell '''
          $port = [int]$env:APP_PORT
          $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
          if (-not $listeners) { Write-Host "port $port is free"; exit 0 }

          $ours = docker port familytree-app-1 8000 2>$null
          if ($ours -match ":$port$") { Write-Host "port $port is held by our own app container"; exit 0 }

          Write-Host "port $port is already in use by another program:"
          $listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            Get-Process -Id $_ -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, Path -AutoSize | Out-String | Write-Host
          }
          Write-Host "pick a free port for APP_PORT in the Jenkinsfile (and the default in docker-compose.yml)."
          exit 1
        '''
        // db first, then align its role password with the credential (it
        // only takes effect on a fresh volume otherwise), then the app.
        bat '''
          docker compose up -d --no-build --wait --wait-timeout 120 db
          if errorlevel 1 (docker compose logs --tail 30 db & exit /b 1)
          docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U familytree -d familytree < sync-db-password.sql
          if errorlevel 1 (echo could not sync the familytree role password & exit /b 1)
          docker compose up -d --no-build --wait --wait-timeout 120
          if errorlevel 1 (docker compose logs --tail 30 app & exit /b 1)
          rem drop the previous build's image, now untagged
          docker image prune -f >nul
          exit /b 0
        '''
      }
    }

    stage('Smoke check') {
      // Through the public host port (APP_PORT), not just the container healthcheck.
      steps {
        bat 'powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 10;$i++){ try { if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:%APP_PORT%/).StatusCode -eq 200){$ok=$true;break} } catch {} ; Start-Sleep 2 }; if(-not $ok){ docker compose logs --tail 30 app; exit 1 }"'
      }
    }
  }

  post {
    failure {
      echo 'Pipeline failed. If it failed before Deploy, the previous app container is still running; otherwise check `docker compose ps` / the stage log above.'
    }
  }
}
