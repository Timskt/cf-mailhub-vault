FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY connector ./connector
COPY src/storage/model.ts ./src/storage/model.ts
RUN pnpm exec esbuild connector/index.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=dist/connector.mjs
RUN pnpm prune --prod

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/connector.mjs ./connector.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "connector.mjs"]
