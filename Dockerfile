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

# Final production image
FROM node:20-slim

# Install build tools (for optional better-sqlite3 migration) and other dependencies
RUN apt-get update && apt-get install -y \
    curl ffmpeg \
    build-essential python3 \
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
# Strip any CRLF line endings (Windows checkouts) so the shebang resolves, then make executable
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV WAV_DIR=/data/wav

EXPOSE 4000

ENTRYPOINT ["/entrypoint.sh"]
