# Use official Node.js image for backend and build
FROM node:20-slim as build

WORKDIR /app

# Install backend dependencies
COPY backend/package.json ./backend/
RUN cd backend && npm install


# Install frontend dependencies and build
COPY frontend/package.json ./frontend/
COPY frontend ./frontend
RUN cd frontend && npm install --legacy-peer-deps && npx react-scripts build

# Copy backend source
COPY backend ./backend

# Final image for running app and sshfs
FROM node:20-slim

# Install build tools, rclone, and other dependencies
RUN apt-get update && apt-get install -y \
    curl fuse3 ffmpeg s3fs \
    build-essential python3 \
    && curl -O https://downloads.rclone.org/rclone-current-linux-amd64.deb \
    && dpkg -i rclone-current-linux-amd64.deb \
    && rm rclone-current-linux-amd64.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and install dependencies (this will rebuild native modules)
COPY --from=build /app/backend/package.json ./backend/
RUN cd backend && npm install

# Copy backend source (without node_modules)
COPY backend/*.js ./backend/
COPY backend/*.json ./backend/
COPY backend/scripts ./backend/scripts
COPY --from=build /app/frontend/build ./frontend/build


# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV WAV_DIR=/data/wav

EXPOSE 4000

ENTRYPOINT ["/entrypoint.sh"]
