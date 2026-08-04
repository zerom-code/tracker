FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# зависимости отдельным слоем — пересобирается только при изменении package.json
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

# сервис работает от непривилегированного пользователя, данные — в томе
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/health || exit 1

CMD ["node", "src/index.js"]
