#!/bin/sh
set -e

# Required env vars: B2_ACCOUNT, B2_KEY, B2_BUCKET, WAV_DIR (local mount)
if [ "$STORAGE_TYPE" = "b2" ]; then
  if [ -z "$B2_ACCOUNT" ] || [ -z "$B2_KEY" ] || [ -z "$B2_BUCKET" ] || [ -z "$SFTP_USER" ] || [ -z "$SFTP_PASS" ] ; then
    echo "Missing Backblaze B2 credentials or bucket. Set B2_ACCOUNT, B2_KEY, B2_BUCKET, SFTP_USER, and SFTP_PASS environment variables."
    exit 1
  fi
elif [ "$STORAGE_TYPE" = "aws" ]; then
  if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$AWS_BUCKET" ] || [ -z "$AWS_REGION" ]; then
    echo "Missing AWS S3 credentials or bucket. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and AWS_BUCKET environment variables."
    exit 1
  fi
else
  echo "Unsupported storage type: $STORAGE_TYPE"
  exit 1
fi

# Create rclone config directory and file
if [ "$STORAGE_TYPE" = "b2" ]; then
  mkdir -p /root/.config/rclone
  cat <<EOF > /root/.config/rclone/rclone.conf
[b2remote]
type = b2
account = $B2_ACCOUNT
key = $B2_KEY
EOF
fi
echo "WAV_DIR is set to: $WAV_DIR"

# Create mount point if it doesn't exist
mkdir -p "$WAV_DIR"

if [ "$STORAGE_TYPE" = "b2" ]; then
  # Mount B2 bucket using rclone
  rclone mount b2remote:$B2_BUCKET "$WAV_DIR" --allow-other --vfs-cache-mode writes &
  sleep 5
fi

if [ "$STORAGE_TYPE" = "aws" ]; then
  # Mount AWS S3 bucket using s3fs
  mkdir -p /etc/s3fs
  echo "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" > /etc/s3fs/credentials
  chmod 600 /etc/s3fs/credentials
  s3fs $AWS_BUCKET "$WAV_DIR" -o passwd_file=/etc/s3fs/credentials -o allow_other 2>&1 | tee /tmp/s3fs.log &
  sleep 5
fi
if ! mountpoint -q "$WAV_DIR"; then
  echo "Mount failed: $WAV_DIR is not a valid mount point"
  cat /tmp/s3fs.log
  exit 1
fi
mkdir -p "$WAV_DIR/cache"

if [ "$ENABLE_SFTP" = "true" ] && [ "$STORAGE_TYPE" = "b2" ] && [ -n "$SFTP_USER" ] && [ -n "$SFTP_PASS" ]; then
  rclone serve sftp b2remote:$B2_BUCKET --addr :2222 --config /root/.config/rclone/rclone.conf --user $SFTP_USER --pass $SFTP_PASS &
fi

# Wait for PostgreSQL to be ready (if DB_HOST is set)
if [ -n "$DB_HOST" ]; then
  echo "Waiting for PostgreSQL at $DB_HOST:${DB_PORT:-5432}..."
  MAX_RETRIES=30
  RETRY_COUNT=0
  until node -e "
    const net = require('net');
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); process.exit(0); });
    sock.on('timeout', () => { sock.destroy(); process.exit(1); });
    sock.on('error', () => { process.exit(1); });
    sock.connect(${DB_PORT:-5432}, '$DB_HOST');
  " 2>/dev/null; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
      echo "❌ PostgreSQL not available after $MAX_RETRIES retries, giving up."
      exit 1
    fi
    echo "⏳ PostgreSQL not ready yet (attempt $RETRY_COUNT/$MAX_RETRIES)..."
    sleep 2
  done
  echo "✅ PostgreSQL is ready!"
fi

# ── Auto-migrate SQLite → PostgreSQL if old .db file exists ──
# Supports SQLITE_PATH env var or the legacy default /root/db/recbot.db
SQLITE_FILE="${SQLITE_PATH:-/root/db/recbot.db}"
if [ -f "$SQLITE_FILE" ]; then
  echo "═══════════════════════════════════════════════════"
  echo "  🔄 SQLite database detected at $SQLITE_FILE"
  echo "  🔄 Running automatic migration to PostgreSQL..."
  echo "═══════════════════════════════════════════════════"
  cd /app/backend
  if node scripts/migrate-sqlite-to-pg.mjs "$SQLITE_FILE"; then
    # Migration succeeded — rename so it won't run again
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP="${SQLITE_FILE}.migrated.${TIMESTAMP}"
    mv "$SQLITE_FILE" "$BACKUP"
    echo "✅ Migration complete. Old file renamed to $BACKUP"
    echo "   (Delete it once you've verified everything works)"
  else
    echo "⚠️  Migration encountered errors (see above)."
    echo "   The SQLite file was NOT renamed — migration will retry on next restart."
    echo "   The app will still start with whatever data made it to PostgreSQL."
  fi
  echo ""
fi

# Start backend server
cd /app/backend
exec npm start



