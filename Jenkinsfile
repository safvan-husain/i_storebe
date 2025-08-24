pipeline {
  agent any
  options { timestamps() }

  environment {
    NODE_VERSION = '20'
    APP_NAME     = 'i-store-be'
    PORT         = '4000'
    NODE_ENV     = 'production'

    BASE_DIR     = '/opt/i-store-be'
    RELEASES_DIR = "${BASE_DIR}/releases"
    CURRENT_LINK = "${BASE_DIR}/current"
    SHARED_DIR   = "${BASE_DIR}/shared"
    KEEP_RELEASES = '5'
  }

  stages {
    stage('Checkout') { steps { checkout scm } }

    stage('Setup Node') {
      steps {
        sh '''
          export NVM_DIR="$HOME/.nvm"
          if [ -s "$NVM_DIR/nvm.sh" ]; then
            . "$NVM_DIR/nvm.sh"
          else
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
            . "$NVM_DIR/nvm.sh"
          fi
          nvm install ${NODE_VERSION}
          nvm use ${NODE_VERSION}
          node -v
          npm -v
        '''
      }
    }

    stage('Install dev deps & Build (tsc)') {
      steps {
        sh '''
          . "$HOME/.nvm/nvm.sh" && nvm use ${NODE_VERSION}
          npm ci
          npm run build
        '''
      }
    }

    stage('Package artifact') {
      steps {
        sh '''
          set -e
          mkdir -p artifact
          cp -a dist package.json package-lock.json ecosystem.config.js artifact/
          (cd artifact && tar -czf ../artifact.tgz .)
          ls -lh artifact.tgz
        '''
      }
    }

    stage('Deploy & Reload with PM2 (with rollback)') {
      steps {
        withCredentials([
          string(credentialsId: 'cred-secret',       variable: 'SECRET'),
          string(credentialsId: 'cred-client-id',    variable: 'CLIENT_ID'),
          string(credentialsId: 'cred-refresh-token',variable: 'REFRESH_TOKEN'),
          string(credentialsId: 'cred-email',        variable: 'EMAIL'),
          string(credentialsId: 'cred-redirect-uri', variable: 'REDIRECT_URI')
        ]) {
          sh '''
            set -euo pipefail
            . "$HOME/.nvm/nvm.sh" && nvm use ${NODE_VERSION}

            if ! command -v pm2 >/dev/null 2>&1; then
              npm i -g pm2
            fi

            # Prepare dirs
            sudo mkdir -p "${RELEASES_DIR}" "${SHARED_DIR}"
            sudo chown -R "$(id -u)":"$(id -g)" "${BASE_DIR}"

            # Create/refresh shared .env with locked permissions (not printed to logs)
            cat > "${SHARED_DIR}/.env" <<EOF
NODE_ENV=${NODE_ENV}
PORT=${PORT}
SECRET=${SECRET}
CLIENT_ID=${CLIENT_ID}
REFRESH_TOKEN=${REFRESH_TOKEN}
EMAIL=${EMAIL}
REDIRECT_URI=${REDIRECT_URI}
EOF
            chmod 600 "${SHARED_DIR}/.env"

            # New release dir
            TS="$(date +%Y%m%d%H%M%S)"
            GITREV="$(git rev-parse --short HEAD || echo no-git)"
            NEW_RELEASE="${RELEASES_DIR}/${TS}-${GITREV}"
            mkdir -p "${NEW_RELEASE}"

            # Unpack artifact and install prod deps
            tar -xzf artifact.tgz -C "${NEW_RELEASE}"
            (cd "${NEW_RELEASE}" && npm ci --omit=dev)

            # Link shared .env into release so PM2 env_file picks it up
            ln -sfn "${SHARED_DIR}/.env" "${NEW_RELEASE}/.env"

            # Flip current symlink (remember previous)
            PREV_TARGET=""
            if [ -L "${CURRENT_LINK}" ]; then
              PREV_TARGET="$(readlink -f "${CURRENT_LINK}")"
            fi
            ln -sfn "${NEW_RELEASE}" "${CURRENT_LINK}"

            # Reload/start via ecosystem (uses env_file)
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

            # Persist PM2 so reboot resurrects this exact app + env_file
            pm2 save || true

            # Cleanup old releases
            ls -1dt "${RELEASES_DIR}"/* 2>/dev/null | awk "NR>${KEEP_RELEASES}" | xargs -r rm -rf
          '''
        }
      }
    }
  }

  post {
    success { echo "Deployed successfully. PM2 managing ${APP_NAME} on :${PORT} with secrets from Jenkins." }
    failure { echo "Deploy failed — automatically reverted to last known good release." }
  }
}
