FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache dumb-init && addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --chown=nodejs:nodejs docs ./docs
RUN mkdir /data && chown nodejs:nodejs /data
USER nodejs
ENV NODE_ENV=production PORT=8094 MARKETPLACE_MCP_STATE_DIR=/data
EXPOSE 8094
VOLUME ["/data"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/http-server.js"]
