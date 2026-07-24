# node:20-slim (Debian) en vez de alpine: pdf-to-img depende de @napi-rs/canvas
# (binding nativo) y slim evita fricciones de compatibilidad con musl.
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
RUN npx prisma generate

EXPOSE 4000
CMD ["node", "dist/src/server.js"]
