# RecBot - Audio Recording Management & Audit Platform

**Version: v1.5.x (current dev branch)**

RecBot is a production-focused web platform for browsing, filtering, auditing, and playing large volumes of telephony call recordings stored in cloud object storage. It includes structured metadata extraction (duration, call ID), session tracking, full audit logging, and performance‑oriented server‑side querying.

## Features

### 🎵 Audio Management
- **Stream Audio Files**: Play recordings directly in the browser with seek support
- **Format Support**: Automatically transcodes telephony formats to browser-compatible PCM
- **Range Requests**: Supports audio scrubbing and seeking with HTTP Range headers
- **S3 Caching**: Transcoded files are cached in S3 for improved performance

### 🔍 Advanced Filtering & Search
- **Date Range Filtering**: Filter recordings by specific dates or date ranges
- **Phone Number Search**: Find recordings by caller phone number
- **Email Search**: Search by agent email address
- **Duration Filtering**: Filter by minimum or maximum call duration
- **Time-based Filtering**: Filter by time of day with multiple modes (range, older than, newer than)

### 📊 Data Management
- **Backend Pagination**: Efficient offset-based pagination for large datasets (10,000+ files)
- **Sorting**: Click any column header to sort by date, time, phone, email, or duration
- **Real-time Filtering**: All filters apply immediately without page refresh
- **Flexible Page Sizes**: Choose from 25, 50, 100, 250, 500, or 1000 files per page

### 🎨 User Interface
- **Dark/Light Mode**: Toggle between themes
- **Responsive Design**: Works on desktop and mobile devices
- **Material UI**: Modern, accessible interface components
- **Loading States**: Visual feedback during data loading

### 🔐 Authentication & Authorization
- **Clerk Authentication**: Email/domain restricted sign‑in (e.g. only approved company domain)
- **Role-Based Access**: Admin, manager, member tiers (download & admin visibility controlled)
- **Session Lifecycle**: Automatic inactivity timeout & hard session expiration with rotation
- **Secure Playback & Download Logging**: Each access event audited with IP & session linkage

### ☁️ Cloud & Storage
- **AWS S3**: Primary storage & streaming source
- **On-Demand Transcoding**: FFmpeg WAV normalization (caching layer possible)
- (Legacy references to B2/SFTP removed for current deployment scope)

## Architecture

### Backend (Node.js / Express)
- **Port**: 4000 (served behind reverse proxy / container)
- **Database**: SQLite (better-sqlite3) with on‑startup adaptive migrations
- **Audio Processing**: FFmpeg for transcoding & stream trimming (Range support)
- **Object Storage**: AWS S3 via AWS SDK v3
- **Auth Middleware**: Clerk + custom role guards
- **Session Engine**: user_sessions table + inactivity & duration expirers
- **Audit Layer**: audit_logs table (LOGIN, LOGOUT with reasons, VIEW_FILES, PLAY_FILE, DOWNLOAD_FILE, MAINTENANCE)

### Frontend (React)
- **React 18 + Material UI**: Responsive data & admin dashboards
- **Filtering UX**: Debounced substring filters (phone, email, callId)
- **Call ID Highlighting**: Partial match highlighting in audit logs
- **Clerk Frontend SDK**: Auth gating & role awareness
- **Session / Audit Visibility**: Admin panel for real‑time log & session review

### Infrastructure
- **Containerization**: Docker multi‑stage image
- **Reverse Proxy**: (Traefik / Nginx compatible)
- **Environment Driven Config**: Minimal required variables
- **Optional CDN**: Cloud distribution of audio objects (not required to run)

## Installation / Deployment

### Prerequisites
- Docker and Docker Compose
- AWS S3 bucket OR Backblaze B2 bucket
- Domain name (for production)

### Environment Variables

Create a `.env` file in the root directory:

```env
# Storage Configuration (choose one)
STORAGE_TYPE=aws  # or "b2" for Backblaze B2

# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_BUCKET=your-bucket-name
AWS_REGION=us-east-1

# Backblaze B2 Configuration (if using B2)
B2_ACCOUNT=your_b2_account_id
B2_KEY=your_b2_application_key
B2_BUCKET=your-b2-bucket-name

# SFTP Configuration (optional)
ENABLE_SFTP=true
SFTP_USER=your_sftp_username
SFTP_PASS=your_sftp_password

CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
CLERK_SECRET_KEY=your_clerk_secret_key
# Comma-separated domains or exact email addresses (e.g. company.com,@partners.io,admin@vendor.com)
ALLOWED_LOGIN_IDENTIFIERS=yourcompany.com
REACT_APP_ALLOWED_LOGIN_IDENTIFIERS=yourcompany.com
MAX_SESSION_HOURS=4
MAX_INACTIVITY_MINUTES=30

# File Storage
WAV_DIR=/data/wav
```

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/dellthePROgrammer/recbot.git
   cd recbot
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Build and start**:
   ```bash
   docker-compose up -d
   ```

4. **Access the application**:
   - Frontend: http://localhost:3000 (or served statically by backend build path)
   - Backend API: http://localhost:4000

### Production Docker Hub Image

Use the pre-built image from Docker Hub:

```yaml
version: '3.8'
services:
  recbot:
   image: ghostreaper69/recbot:v1.5.23
    # or use: ghostreaper69/recbot:latest
    ports:
      - "4000:4000"
    environment:
      - STORAGE_TYPE=aws
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - AWS_BUCKET=${AWS_BUCKET}
      - AWS_REGION=${AWS_REGION}
    volumes:
      - wav_data:/data/wav
      - db_data:/root/db
```

## Usage

### File & Metadata Model

Recordings organized by date folders (M_D_YYYY):
```
recordings/
├── 9_26_2025/
│   ├── 2012055255 by user@domain.com @ 9_47_43 AM_18600.wav
│   ├── 2012079443 by user@domain.com @ 9_33_50 AM_4200.wav
│   └── ...
├── 9_27_2025/
│   └── ...
```

**Primary Filename Formats**:

1. Legacy: `{phone} by {email} @ {H_MM_SS AM|PM}_{duration_ms}.wav`
2. New (with callId): `{phone} by {email} @ {H_MM_SS AM|PM}_{duration_ms}_{callId}.wav`

Parsed Fields:
- phone
- email
- call_date (derived from folder)
- call_time (normalized HH:MM:SS 24h)
- duration_ms
- call_id (optional legacy absence)

Backfill routines populate missing `call_id` and `duration_ms` where recoverable.

### API Endpoints

#### Get Files
```http
GET /api/wav-files?dateStart=9_26_2025&dateEnd=9_27_2025&offset=0&limit=25
```

Key Query Parameters (files):
- dateStart, dateEnd (M_D_YYYY)
- offset, limit
- phone, email (substring match)
- callId (substring match)
- durationMin (minimum duration in seconds)
- timeStart, timeEnd (if timeMode=range)
- sortColumn: date | time | phone | email | durationMs | callId
- sortDirection: asc | desc

#### Stream Audio
```http
GET /api/wav-files/recordings/9_26_2025/filename.wav
```

Supports HTTP Range requests for audio seeking.

### Authentication Setup (Clerk)

1. Create a Clerk application → obtain Publishable & Secret keys.
2. Configure allowed email/domain allowlist (or enforce in middleware with ALLOWED_LOGIN_IDENTIFIERS).
3. Add keys to environment (.env or container env vars).
4. Deploy – frontend uses Clerk React SDK; backend validates JWT / session via Clerk middleware.

## Development

### Local Development

1. **Install dependencies**:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```

2. **Start development servers**:
   ```bash
   # Backend (port 4000)
   cd backend && npm start
   
   # Frontend (port 3000)
   cd frontend && npm start
   ```

### Building Docker Image

```bash
# Build with version tag
docker build -t ghostreaper69/recbot:v1.1.0 .

# Push to Docker Hub
docker push ghostreaper69/recbot:v1.1.0
```

## Performance & Scaling

### Optimizations
- Server-side filtering & ordering via indexed SQLite queries
- Partial LIKE matching (phone, email, callId) with pragmatic indexes
- Session pruning tasks prevent table bloat
- Optional caching layer for transcoded outputs (future optimization)

### Scaling Considerations
- Designed for hundreds of thousands of rows (WAL mode, tuned pragmas advisable)
- Add covering indexes if new heavy filters introduced
- Potential future move: shard or externalize to Postgres when concurrency demands it
- CDN or signed URLs for global latency reduction if required

## Troubleshooting

### Common Issues

**Files not loading**:
- Check S3/B2 credentials and bucket permissions
- Verify file structure matches expected format
- Check Docker container logs: `docker-compose logs recbot`

**Authentication not working**:
- Verify Clerk keys & domain restrictions
- Confirm frontend and backend share the same Clerk environment settings

**Audio not playing**:
- Check FFmpeg installation in container
- Verify audio file formats are supported
- Check browser console for errors

### Logs

```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f recbot
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting section
- Review Docker container logs

## Changelog

### Recent Highlights (v1.5.x series)
- Call ID extraction & backfill
- Substring filtering for audit & file callId
- Admin session & audit dashboards
- Inactivity + auto-expire session logic
- Consolidated playback/download audit entries
- IP resolution behind proxy (Cloudflare / Traefik)
- Backfill endpoints (sessions & file metadata)

### Earlier Milestones
- Initial pagination & sorting foundation
- Filename parsing & duration capture
- Role-based access control
- Core audio streaming + range seeking

---

**Built for operational clarity, compliance, and speed.**