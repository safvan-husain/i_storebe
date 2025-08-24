pipeline {
  agent any
  options { timestamps() }

  environment {
    // --- App / Runtime ---
    APP_NAME     = 'i-store-be'
    PORT         = '4000'
    TEST_PORT    = '4001'
    NODE_ENV     = 'production'

    // --- Deploy paths on the target server ---
    BASE_DIR     = '/opt/i-store-be'
    APP_DIR      = "${BASE_DIR}/app"
    SHARED_DIR   = "${BASE_DIR}/shared"
    TEST_DIR     = "${BASE_DIR}/test"
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Install dev deps & Build (tsc)') {
      steps {     
        sh '''
          set -eu
          npm ci --production=false
          npm run build
        '''
      }
    }

    stage('Package artifact') {
      steps {
        sh '''
          set -eu
          rm -rf artifact artifact.tgz
          mkdir -p artifact

          # Include runtime necessities only
          cp -a dist package.json package-lock.json ecosystem.config.js artifact/

          (cd artifact && tar -czf ../artifact.tgz .)
          ls -lh artifact.tgz
        '''
      }
    }

    stage('Test new version on temp port') {
      steps {
        withCredentials([
          string(credentialsId: 'cred-secret',        variable: 'SECRET'),
          string(credentialsId: 'cred-client-id',     variable: 'CLIENT_ID'),
          string(credentialsId: 'cred-refresh-token', variable: 'REFRESH_TOKEN'),
          string(credentialsId: 'cred-email',         variable: 'EMAIL'),
          string(credentialsId: 'cred-redirect-uri',  variable: 'REDIRECT_URI'),
          string(credentialsId: 'cred-firebase-sa-b64', variable: 'FIREBASE_SA_B64')
        ]) {
          sh '''
            set -eu

            # Ensure pm2 exists
            if ! command -v pm2 >/dev/null 2>&1; then
              echo "pm2 not found on PATH. Please install pm2 globally on the host before running this job." >&2
              exit 1
            fi

            # Prepare test directory
            mkdir -p "${TEST_DIR}"
            chown -R "$(id -u)":"$(id -g)" "${TEST_DIR}" 2>/dev/null || true

            # Write test .env with test port
            cat > "${TEST_DIR}/.env" <<EOF
NODE_ENV=${NODE_ENV}
PORT=${TEST_PORT}
SECRET=${SECRET}
CLIENT_ID=${CLIENT_ID}
REFRESH_TOKEN=${REFRESH_TOKEN}
EMAIL=${EMAIL}
REDIRECT_URI=${REDIRECT_URI}
FIREBASE_SA_B64=${FIREBASE_SA_B64}
EOF
            chmod 600 "${TEST_DIR}/.env"

            # Unpack artifact to test dir and install production deps
            tar -xzf artifact.tgz -C "${TEST_DIR}"
            (cd "${TEST_DIR}" && npm ci --omit=dev)

            # Start test app with PM2
            TEST_APP_NAME="${APP_NAME}-test"
            pm2 start "${TEST_DIR}/ecosystem.config.js" --name "${TEST_APP_NAME}" -- --port ${TEST_PORT} || {
              echo "Failed to start test app" >&2
              pm2 delete "${TEST_APP_NAME}" || true
              exit 1
            }

            # Wait briefly for app to start
            sleep 5

            # Verify with curl (adjust endpoint as needed)
            if ! curl -s -o /dev/null -w "%{http_code}" "http://localhost:${TEST_PORT}/health" | grep -q 200; then
              echo "Test app failed health check" >&2
              pm2 delete "${TEST_APP_NAME}" || true
              exit 1
            fi

            # Clean up test app
            pm2 delete "${TEST_APP_NAME}" || true
          '''
        }
      }
    }

    stage('Deploy & Reload with PM2') {
      steps {
        withCredentials([
          string(credentialsId: 'cred-secret',        variable: 'SECRET'),
          string(credentialsId: 'cred-client-id',     variable: 'CLIENT_ID'),
          string(credentialsId: 'cred-refresh-token', variable: 'REFRESH_TOKEN'),
          string(credentialsId: 'cred-email',         variable: 'EMAIL'),
          string(credentialsId: 'cred-redirect-uri',  variable: 'REDIRECT_URI'),
          string(credentialsId: 'cred-firebase-sa-b64', variable: 'FIREBASE_SA_B64')
        ]) {
          sh '''
            set -eu

            # Ensure pm2 exists
            if ! command -v pm2 >/dev/null 2>&1; then
              echo "pm2 not found on PATH. Please install pm2 globally on the host before running this job." >&2
              exit 1
            fi

            # Prepare app and shared directories
            mkdir -p "${APP_DIR}" "${SHARED_DIR}"
            chown -R "$(id -u)":"$(id -g)" "${BASE_DIR}" 2>/dev/null || true

            # Write shared .env securely
            cat > "${SHARED_DIR}/.env" <<EOF
NODE_ENV=${NODE_ENV}
PORT=${PORT}
SECRET=${SECRET}
CLIENT_ID=${CLIENT_ID}
REFRESH_TOKEN=${REFRESH_TOKEN}
EMAIL=${EMAIL}
REDIRECT_URI=${REDIRECT_URI}
FIREBASE_SA_B64=${FIREBASE_SA_B64}
EOF
            chmod 600 "${SHARED_DIR}/.env"

            # Remove old app contents (except .env link)
            rm -rf "${APP_DIR}/dist" "${APP_DIR}/package.json" "${APP_DIR}/package-lock.json" "${APP_DIR}/ecosystem.config.js"

            # Unpack artifact to app dir and install production deps
            tar -xzf artifact.tgz -C "${APP_DIR}"
            (cd "${APP_DIR}" && npm ci --omit=dev)

            # Link shared .env into app dir
            ln -sfn "${SHARED_DIR}/.env" "${APP_DIR}/.env"

            # Reload/start via PM2 ecosystem (zero-downtime)
            pm2 startOrReload "${APP_DIR}/ecosystem.config.js" --only "${APP_NAME}"

            # Persist PM2 process list
            pm2 save || true
          '''
        }
      }
    }
  }

  post {
    success {
      echo "✅ Deployed successfully. PM2 managing ${APP_NAME} on :${PORT}."
    }
    failure {
      echo "❌ Deploy failed — production app unchanged."
    }
  }
}