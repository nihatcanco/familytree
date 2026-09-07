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
    // Full paths — the Jenkins service account's PATH usually has neither.
    // PYTHON: all-users python.org install. NSSM: wherever nssm.exe was dropped.
    PYTHON  = 'C:/Program Files/Python312/python.exe'
    NSSM    = 'C:\\tools\\nssm.exe'
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
            /XD .git .github tests __pycache__ .venv-test .venv .claude logs
          set RC=%ERRORLEVEL%
          rem robocopy: 0-7 = success, 8+ = real error
          if %RC% GEQ 8 (echo robocopy failed with exit code %RC% & exit /b %RC%)
          if not exist "%APP_DIR%\\server.py" (echo deploy did not land: server.py missing in %APP_DIR% & exit /b 1)
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
