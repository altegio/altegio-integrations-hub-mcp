FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install --global npm@12.2.2 --ignore-scripts && npm ci --ignore-scripts --registry=https://registry.npmjs.org
COPY src ./src
RUN npm run build

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
RUN apk add --no-cache dumb-init && addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/altegio/altegio-integrations-hub-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
COPY package*.json ./
RUN npm install --global npm@12.2.2 --ignore-scripts && npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --chown=nodejs:nodejs docs/marketplace-internals.md docs/embedded-surfaces.md docs/safe-e2e.md docs/tool-boundaries.md docs/webhooks.md ./docs/
COPY LICENSE ./LICENSE
RUN mkdir /data && chown nodejs:nodejs /data
USER nodejs
ENV NODE_ENV=production PORT=8094 MCP_HTTP_HOST=0.0.0.0 INTEGRATIONS_HUB_MCP_STATE_DIR=/data
EXPOSE 8094
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/http-server.js"]
