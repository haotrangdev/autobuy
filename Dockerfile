# ══════════════════════════════════════════════════════════════════
#  Dockerfile – AutoBuy Bot
#  Multi-stage build: deps → runtime
# ══════════════════════════════════════════════════════════════════

FROM node:20-slim AS base

# Cài Chrome dependencies cho Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Dùng Chromium có sẵn thay vì download bundled
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# ── Dependencies stage ────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Runtime stage ─────────────────────────────────────────────────
FROM base AS runtime

WORKDIR /app

# Copy deps từ stage trước
COPY --from=deps /app/node_modules ./node_modules

# Copy source (không copy sites/, logs/, sessions/)
COPY *.js ./
COPY ui-web/ ./ui-web/
COPY sites/example.json ./sites/example.json

# Tạo thư mục runtime
RUN mkdir -p logs sessions sites

# Non-root user để tăng bảo mật
RUN groupadd -r autobuy && useradd -r -g autobuy autobuy \
    && chown -R autobuy:autobuy /app
USER autobuy

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "index.js"]
