# syntax=docker/dockerfile:1
# glow-control (govee-lights) — served from Coolify.
# Runtime shape: src/ (bun server) + dist/ (vite build) + /app/data (persistent volume).
# Server binds Bun.env.HOST / Bun.env.PORT (set via Coolify env: HOST=0.0.0.0, PORT=3000).

FROM oven/bun:1.4.0-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1.4.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY src ./src
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["bun", "src/index.ts"]
