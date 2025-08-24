pipeline {
  agent any
  options { timestamps() }

  environment {
    // --- App / Runtime ---
    APP_NAME     = 'i-store-be'
    PORT         = '4000'
    NODE_ENV     = 'production'

    // --- Deploy path ---
    BASE_DIR     = '/opt/i-store-be'
    APP_DIR      = "${BASE_DIR}/app"
    SHARED_DIR   = "${BASE_DIR}/shared"
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Build (tsc)') {
      steps {
        sh '''
          set -eu
          npm ci --production=false
          npx tsc
        '''
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

            # Write .env securely
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

            # Copy built files and dependencies to app dir
            rm -rf "${APP_DIR}/dist" "${APP_DIR}/package.json" "${APP_DIR}/package-lock.json" "${APP_DIR}/ecosystem.config.js"
            cp -a dist package.json package-lock.json ecosystem.config.js "${APP_DIR}/"
            (cd "${APP_DIR}" && npm ci --omit=dev)

            # Link shared .env
            ln -sfn "${SHARED_DIR}/.env" "${APP_DIR}/.env"

            # Reload/start via PM2
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