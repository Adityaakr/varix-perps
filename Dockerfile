FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services ./services
COPY web ./web
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services ./services
COPY --from=build /app/web ./web
COPY --from=build /app/.env.example ./.env.example
ENV NODE_ENV=production
CMD ["sh", "-lc", "pnpm --filter @varix/indexer start & pnpm --filter @varix/oracle-relay start & pnpm --filter @varix/liquidation-watcher start & pnpm --filter @varix/market-data-proxy start & pnpm --filter @varix/web start"]
