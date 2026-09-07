// CI/CD for the family-tree app on a Windows Jenkins service.
//
//   GitHub (private)  --clone via SSH deploy key-->  Jenkins
//   Jenkins           --run tests, mirror code-->    C:\apps\familytree
//   Jenkins           --nssm restart-->              "familytree" Windows service (server.py :8000)
//   Apache            --mod_proxy-->                  127.0.0.1:8000
//
// The live database (data.sqlite) lives in APP_DIR and is never overwritten by a
// deploy: robocopy /XF excludes it from both the copy and the /MIR purge.
// See DEPLOY.md for the one-time server setup (NSSM service, Apache proxy, job).

pipeline {
  agent any

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
    // Needs Python on the SYSTEM Path (all-users python.org install), with Jenkins
    // restarted afterwards so the service sees it. If you must point at a specific
    // python.exe instead, use forward slashes: 'C:/Program Files/Python312/python.exe'
    PYTHON  = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Test') {
      steps {
        // stdlib-only API integration test; spins up its own throwaway DB.
        bat '"%PYTHON%" tests\\test_api.py'
      }
    }

    stage('Deploy code') {
      steps {
        bat '''
          if not exist "%APP_DIR%" mkdir "%APP_DIR%"
          robocopy "%WORKSPACE%" "%APP_DIR%" /MIR /NFL /NDL /NP /R:2 /W:5 ^
            /XF data.sqlite ^
            /XD .git .github tests __pycache__ .venv-test .venv .claude
          set RC=%ERRORLEVEL%
          rem robocopy: 0-7 = success, 8+ = real error
          if %RC% GEQ 8 exit /b %RC%
          exit /b 0
        '''
      }
    }

    stage('Seed database (first deploy only)') {
      steps {
        bat 'if not exist "%APP_DIR%\\data.sqlite" copy /Y "%WORKSPACE%\\data.sqlite" "%APP_DIR%\\data.sqlite"'
      }
    }

    stage('Restart service') {
      steps {
        bat 'nssm restart %SERVICE%'
      }
    }

    stage('Smoke check') {
      steps {
        bat 'powershell -NoProfile -Command "Start-Sleep 3; try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 http://127.0.0.1:8000/; if ($r.StatusCode -ne 200) { exit 1 } } catch { Write-Error $_; exit 1 }"'
      }
    }
  }

  post {
    failure {
      echo 'Deploy failed. Service left running on the previous code; check the stage log above.'
    }
  }
}
