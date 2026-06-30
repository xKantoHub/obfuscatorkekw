# Dockerfile for Render — Node.js backend + Lua 5.1 + Prometheus obfuscator
FROM node:18-bullseye-slim

# Install Lua 5.1, LuaRocks, git, and build tools needed by Prometheus
RUN apt-get update && apt-get install -y --no-install-recommends \
    lua5.1 \
    liblua5.1-0-dev \
    git \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Make "lua" point at lua5.1 (Debian installs it as lua5.1, not lua)
RUN ln -s /usr/bin/lua5.1 /usr/bin/lua

WORKDIR /app

# Install Node deps first (layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Clone Prometheus (the obfuscator engine itself, pure Lua)
RUN git clone --depth 1 https://github.com/wcrddn/Prometheus.git /app/Prometheus

# Copy our server wrapper
COPY server.js ./

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
