FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# 使用非 root 帳號執行以強化容器資安
USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
