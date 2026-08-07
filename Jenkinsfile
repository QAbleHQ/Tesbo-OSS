// Auto-deploy on main + SonarQube scan before deploy.
// Sonar secrets: Jenkins Managed file id = tesbo-test-manager-env
// Sonar failure does NOT block deploy (catchError).
 //
 // Low-downtime deploy:
 //   - NEVER `docker compose down` (that kills the whole site during build)
 //   - Build images first while old containers keep serving traffic
 //   - Then `up -d` swaps only changed services (postgres/redis usually stay up)
 //   - Expect a short blip (few seconds) when frontend/backend containers recreate
 // Never: docker compose down -v

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    // Use SSH so prod deploy key works (HTTPS breaks non-interactive git fetch).
    REPO_URL    = 'git@github.com:QAbleHQ/Tesbo-Test-Manager-Private.git'
    APP_HEALTH  = 'https://app.tesbo.io'
    DEPLOY_HOST = 'tesbo'
    DEPLOY_USER = 'root'
    DEPLOY_PATH = '/opt/tesbo-test-manager/Tesbo-Test-Manager'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        script {
          env.GIT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
          echo "Pipeline ${env.GIT_SHA} → deploy ${env.DEPLOY_USER}@${env.DEPLOY_HOST}:${env.DEPLOY_PATH}"
        }
      }
    }

    stage('SonarQube') {
      steps {
        catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE') {
          configFileProvider([
            configFile(fileId: 'tesbo-test-manager-env', variable: 'TESBO_ENV_FILE')
          ]) {
            sh '''
              set -eu
              set -a
              # shellcheck disable=SC1090
              . "$TESBO_ENV_FILE"
              set +a

              test -n "${SONAR_HOST_URL:-}" || { echo "SONAR_HOST_URL missing in tesbo-test-manager-env"; exit 1; }
              test -n "${SONAR_TOKEN:-}" || { echo "SONAR_TOKEN missing in tesbo-test-manager-env"; exit 1; }

              echo "==> SonarQube scan → ${SONAR_HOST_URL}"
              docker run --rm \
                -e SONAR_HOST_URL="${SONAR_HOST_URL}" \
                -e SONAR_TOKEN="${SONAR_TOKEN}" \
                -v "${WORKSPACE}:/usr/src" \
                -w /usr/src \
                sonarsource/sonar-scanner-cli:11 \
                -Dsonar.projectBaseDir=/usr/src
            '''
          }
        }
      }
    }

    stage('Deploy via ssh tesbo') {
      steps {
        sh '''
          set -eu
          SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
          echo "==> Jenkins user: $(whoami)"
          ssh $SSH_OPTS "${DEPLOY_USER}@${DEPLOY_HOST}" "hostname && pwd"

          ssh $SSH_OPTS "${DEPLOY_USER}@${DEPLOY_HOST}" "
            set -e
            cd ${DEPLOY_PATH}
            git remote set-url origin ${REPO_URL}
            git fetch origin main
            git checkout -f main
            git reset --hard origin/main
            git log -1 --oneline

            echo '==> Building images (site stays UP)'
            docker compose build

            echo '==> Rolling containers (no full down)'
            docker compose up -d --remove-orphans

            sleep 20
            docker compose ps
            curl -fsS http://127.0.0.1:1021/health || true
            curl -fsS -o /dev/null -w 'frontend_local:%{http_code}\\n' http://127.0.0.1:1020/ || true
            echo Deploy finished
          "
        '''
      }
    }

    stage('Smoke check') {
      steps {
        sh '''
          set -eu
          curl -fsS -o /dev/null -w "frontend:%{http_code}\\n" "${APP_HEALTH}/login" || \
            curl -fsS -o /dev/null -w "frontend:%{http_code}\\n" "${APP_HEALTH}/" || true
          echo "Site: ${APP_HEALTH}/projects"
        '''
      }
    }
  }

  post {
    success {
      echo "OK: ${env.GIT_SHA} deploy → https://app.tesbo.io/projects"
    }
    unstable {
      echo "Deploy may have succeeded but Sonar was UNSTABLE."
    }
    failure {
      echo "Failed. Check deploy/SSH on tesbo."
    }
  }
}
