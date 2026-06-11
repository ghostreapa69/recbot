#!/bin/sh
set -e

# Storage credentials are still required for the AWS SDK (direct S3 access).
# The WAV_DIR volume is now mounted externally via the rclone Docker volume plugin.
if [ "$STORAGE_TYPE" = "aws" ]; then
  if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$AWS_BUCKET" ] || [ -z "$AWS_REGION" ]; then
    echo "Missing AWS S3 credentials or bucket. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and AWS_BUCKET environment variables."
    exit 1
  fi
elif [ "$STORAGE_TYPE" = "b2" ]; then
  if [ -z "$B2_ACCOUNT" ] || [ -z "$B2_KEY" ] || [ -z "$B2_BUCKET" ]; then
    echo "Missing Backblaze B2 credentials or bucket. Set B2_ACCOUNT, B2_KEY, and B2_BUCKET environment variables."
    exit 1
  fi
else
  echo "Unsupported storage type: $STORAGE_TYPE"
  exit 1
fi

echo "WAV_DIR is set to: $WAV_DIR"
mkdir -p "$WAV_DIR"


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



