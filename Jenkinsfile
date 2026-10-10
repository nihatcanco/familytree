// CI/CD for the family-tree app on a Windows Jenkins service.
//
//   GitHub (private)  --clone via SSH deploy key-->  Jenkins
//   Jenkins           --run tests, mirror code-->    C:\apps\familytree
//   Jenkins           --nssm restart-->              "familytree" Windows service (server.py :8000)
//   Apache            --mod_proxy-->                  127.0.0.1:8000
//
// The live database is PostgreSQL (a separate Windows service); deploys only
// ever touch code. server.py runs from a venv in APP_DIR (psycopg) and creates
// its schema on startup. See DEPLOY.md for the one-time server setup
// (PostgreSQL, NSSM service, Apache proxy, job).

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
    APP_DIR = 'C:\\apps\\familytree'
    SERVICE = 'familytree'
    // Full paths — the Jenkins service account's PATH usually has neither.
    // PYTHON: all-users python.org install. NSSM: wherever nssm.exe was dropped.
    PYTHON  = 'C:/Program Files/Python312/python.exe'
    NSSM    = 'C:\\tools\\nssm.exe'
    // The deployed app and the test suite each get their own venv.
    APP_PY  = 'C:\\apps\\familytree\\.venv\\Scripts\\python.exe'
    // Scratch DB on the local PostgreSQL for the Test stage (see DEPLOY.md).
    TEST_DATABASE_URL = 'postgresql://familytree_test:familytree_test@localhost/familytree_test'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Stamp version') {
      // Rewrite version.json so the app footer can show the Jenkins build
      // number. Robocopy in 'Deploy code' copies it to APP_DIR as-is; the
      // repo's committed version.json (build "dev") is only for local runs.
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
      // but the app sits behind Apache's mod_proxy and, per DEPLOY.md, is
      // reached through a tunnel/reverse-proxy setup that isn't guaranteed to
      // honor that header -- a changed URL forces a fresh fetch regardless of
      // what any in-between cache does with the headers.
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

    stage('Test') {
      steps {
        // API integration test. Builds a workspace venv, then resets and seeds
        // the scratch PostgreSQL database (TEST_DATABASE_URL) and exercises
        // every endpoint against a real server.
        bat '''
          "%PYTHON%" -m venv .venv || exit /b 1
          ".venv\\Scripts\\python.exe" -m pip install -q -r requirements.txt || exit /b 1
          ".venv\\Scripts\\python.exe" tests\\test_api.py || exit /b 1
        '''
      }
    }

    stage('Deploy code') {
      steps {
        bat '''
          if not exist "%APP_DIR%" mkdir "%APP_DIR%"
          robocopy "%WORKSPACE%" "%APP_DIR%" /MIR /NFL /NDL /NP /R:2 /W:5 ^
            /XD .git .github tests __pycache__ .venv-test .venv .claude logs ^
            /XF README.md DEPLOY.md Jenkinsfile docker-compose.test.yml .gitignore
          set RC=%ERRORLEVEL%
          rem robocopy: 0-7 = success, 8+ = real error
          if %RC% GEQ 8 (echo robocopy failed with exit code %RC% & exit /b %RC%)
          rem /XF makes robocopy skip these files entirely, so /MIR never purges
          rem copies that landed in APP_DIR from builds before this exclusion
          rem existed -- remove them explicitly. No-op once they're gone for good.
          for %%F in (README.md DEPLOY.md Jenkinsfile docker-compose.test.yml .gitignore) do (
            if exist "%APP_DIR%\\%%F" del /f /q "%APP_DIR%\\%%F"
          )
          if not exist "%APP_DIR%\\server.py" (echo deploy did not land: server.py missing in %APP_DIR% & exit /b 1)
          exit /b 0
        '''
      }
    }

    stage('Install dependencies') {
      // server.py needs psycopg; keep the APP_DIR venv in sync with
      // requirements.txt on every deploy (fast no-op when unchanged).
      steps {
        bat '''
          if not exist "%APP_PY%" "%PYTHON%" -m venv "%APP_DIR%\\.venv" || exit /b 1
          "%APP_PY%" -m pip install -q -r "%APP_DIR%\\requirements.txt" || exit /b 1
        '''
      }
    }

    stage('Restart service') {
      steps {
        bat '''
          "%NSSM%" restart %SERVICE%
          rem give the process a moment, then confirm it is actually RUNNING
          powershell -NoProfile -Command "Start-Sleep 3; $s=(Get-Service '%SERVICE%').Status; Write-Host \\"service status: $s\\"; if ($s -ne 'Running') { Get-Content 'C:\\apps\\familytree\\logs\\err.log' -Tail 30 -ErrorAction SilentlyContinue; exit 1 }"
        '''
      }
    }

    stage('Smoke check') {
      steps {
        bat 'powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 10;$i++){ try { if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8000/).StatusCode -eq 200){$ok=$true;break} } catch {} ; Start-Sleep 2 }; if(-not $ok){ Get-Content \'C:\\apps\\familytree\\logs\\err.log\' -Tail 30 -ErrorAction SilentlyContinue; exit 1 }"'
      }
    }
  }

  post {
    failure {
      echo 'Deploy failed. Service left running on the previous code; check the stage log above.'
    }
  }
}
