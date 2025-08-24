pipeline {
  agent any
  options { timestamps() }

  environment {
    // --- App / Runtime ---
    APP_NAME     = 'i-store-be'
    PORT         = '4000'
    NODE_ENV     = 'production'

    // --- Deploy paths on the target server (same box Jenkins is building on) ---
    BASE_DIR     = '/opt/i-store-be'
    RELEASES_DIR = "${BASE_DIR}/releases"
    CURRENT_LINK = "${BASE_DIR}/current"
    SHARED_DIR   = "${BASE_DIR}/shared"

    // housekeeping
    KEEP_RELEASES = '5'
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

    stage('Deploy & Reload with PM2 (with rollback)') {
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

            # Ensure pm2 exists (do NOT install here)
            if ! command -v pm2 >/dev/null 2>&1; then
              echo "pm2 not found on PATH. Please install pm2 globally on the host before running this job." >&2
              exit 1
            fi

            # Prepare dirs and ownership
            mkdir -p "${RELEASES_DIR}" "${SHARED_DIR}"
            chown -R "$(id -u)":"$(id -g)" "${BASE_DIR}" 2>/dev/null || true

            # Write shared .env securely (masked in Jenkins logs)
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

            # Create new release dir
            TS="$(date +%Y%m%d%H%M%S)"
            GITREV="$(git rev-parse --short HEAD || echo no-git)"
            NEW_RELEASE="${RELEASES_DIR}/${TS}-${GITREV}"
            mkdir -p "${NEW_RELEASE}"

            # Unpack artifact and install production deps
            tar -xzf artifact.tgz -C "${NEW_RELEASE}"
            (cd "${NEW_RELEASE}" && npm ci --omit=dev)

            # Link shared .env into this release for PM2 env_file
            ln -sfn "${SHARED_DIR}/.env" "${NEW_RELEASE}/.env"

            # Flip current symlink atomically (remember previous for rollback)
            PREV_TARGET=""
            if [ -L "${CURRENT_LINK}" ]; then
              PREV_TARGET="$(readlink -f "${CURRENT_LINK}")"
            fi
            ln -sfn "${NEW_RELEASE}" "${CURRENT_LINK}"

            # Reload/start via PM2 ecosystem (zero-downtime)
            set +e
            pm2 startOrReload "${CURRENT_LINK}/ecosystem.config.js" --only "${APP_NAME}"
            PM2_RC=$?
            set -e

            if [ $PM2_RC -ne 0 ]; then
              echo "PM2 reload failed! Rolling back…"
              if [ -n "$PREV_TARGET" ] && [ -d "$PREV_TARGET" ]; then
                ln -sfn "$PREV_TARGET" "${CURRENT_LINK}"
                pm2 startOrReload "${CURRENT_LINK}/ecosystem.config.js" --only "${APP_NAME}" || true
              else
                echo "No previous release to roll back to."
              fi
              exit 1
            fi

            # Persist PM2 process list so reboot resurrects the current app
            pm2 save || true

            # Cleanup old releases (keep last N)
            ls -1dt "${RELEASES_DIR}"/* 2>/dev/null | awk "NR>${KEEP_RELEASES}" | xargs -r rm -rf
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
      echo "❌ Deploy failed — kept/rolled back to last known good release."
    }
  }
}
