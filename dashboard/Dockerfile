# Build without runtime credentials; environment files are excluded from context.
FROM node:24-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
WORKDIR /app/dashboard
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY src/contracts /app/src/contracts
COPY dashboard /app/dashboard
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3001
COPY --from=build --chown=node:node /app/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/dashboard/.next/static ./dashboard/.next/static
USER node
EXPOSE 3001
CMD ["node", "dashboard/server.js"]
