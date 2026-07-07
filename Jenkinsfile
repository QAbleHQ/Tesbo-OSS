pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timeout(time: 45, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    triggers {
        githubPush()
    }

    environment {
        REMOTE_HOST        = 'tesbo-prod-deploy'
        REMOTE_APP_DIR     = '/opt/tesbo-test-manager/Tesbo-Test-Manager'
        SSH_CONFIG         = '/var/lib/jenkins/.ssh/config_tesbo_prod'
        SONAR_PROJECT_KEY  = 'tesbo-test-manager'
        SONAR_PROJECT_NAME = 'Tesbo Test Manager'
        SONAR_SOURCES      = 'Tesbo-Backend-Nest/src,Tesbo-Frontend'
        SONAR_EXCLUSIONS   = '**/node_modules/**,**/.next/**,**/dist/**,**/coverage/**,**/*.spec.ts,**/*.test.ts,**/migrations/**'
        TESBO_ENV_FILE_ID  = 'tesbo-test-manager-env'
        SONAR_SCANNER_VERSION = '5.0.1.3006'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('SonarQube Scan') {
            steps {
                configFileProvider([configFile(fileId: "${TESBO_ENV_FILE_ID}", variable: 'TESBO_ENV')]) {
                    sh '''
                        set -e
                        set -a
                        . "${TESBO_ENV}"
                        set +a

                        test -n "${SONAR_HOST_URL}" || { echo "SONAR_HOST_URL missing in managed file"; exit 1; }
                        test -n "${SONAR_TOKEN}" || { echo "SONAR_TOKEN missing in managed file"; exit 1; }

                        SCANNER_DIR="${WORKSPACE}/.sonar-scanner"
                        if [ ! -x "${SCANNER_DIR}/bin/sonar-scanner" ]; then
                          echo "Downloading sonar-scanner ${SONAR_SCANNER_VERSION}..."
                          curl -fsSL -o /tmp/sonar-scanner.zip \
                            "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-linux.zip"
                          rm -rf /tmp/sonar-scanner-unpack "${SCANNER_DIR}"
                          unzip -q /tmp/sonar-scanner.zip -d /tmp/sonar-scanner-unpack
                          mv /tmp/sonar-scanner-unpack/sonar-scanner-* "${SCANNER_DIR}"
                        fi

                        "${SCANNER_DIR}/bin/sonar-scanner" \
                          -Dsonar.projectKey="${SONAR_PROJECT_KEY}" \
                          -Dsonar.projectName="${SONAR_PROJECT_NAME}" \
                          -Dsonar.sources="${SONAR_SOURCES}" \
                          -Dsonar.sourceEncoding=UTF-8 \
                          -Dsonar.exclusions="${SONAR_EXCLUSIONS}" \
                          -Dsonar.host.url="${SONAR_HOST_URL}" \
                          -Dsonar.token="${SONAR_TOKEN}"
                    '''
                }
            }
        }

        stage('Deploy master branch') {
            when {
                anyOf {
                    branch 'master'
                    expression { env.GIT_BRANCH == 'origin/master' }
                    expression { env.BRANCH_NAME == 'master' }
                }
            }
            steps {
                echo 'SonarQube passed — deploying Tesbo master over dedicated SSH config...'
                sh '''
                    set -e
                    test -f "${SSH_CONFIG}"

                    # rsync --delete mirrors the workspace to the server and removes files
                    # deleted from git (tar extract only overwrites and leaves stale files behind).
                    rsync -az --delete \
                      --exclude='.git/' \
                      --exclude='node_modules/' \
                      --exclude='.next/' \
                      --exclude='.env' \
                      --exclude='docker-compose.yml' \
                      --exclude='infra/docker/postgres/pg_hba.conf' \
                      --exclude='Jenkinsfile' \
                      -e "ssh -F ${SSH_CONFIG}" \
                      ./ ${REMOTE_HOST}:${REMOTE_APP_DIR}/

                    ssh -F "${SSH_CONFIG}" ${REMOTE_HOST} "
                      set -e
                      cd '${REMOTE_APP_DIR}'
                      docker compose up --build -d --wait --wait-timeout 300
                      docker compose ps
                      curl -fsS http://127.0.0.1:1011/health
                      curl -fsS -o /dev/null http://127.0.0.1:1010/
                    "
                '''
            }
        }
    }

    post {
        success {
            echo 'Pipeline completed successfully.'
        }
        failure {
            sh '''
                ssh -F "${SSH_CONFIG}" ${REMOTE_HOST} "
                  cd '${REMOTE_APP_DIR}' && docker compose logs --tail=60 backend frontend migrator || true
                " || true
            '''
        }
    }
}
