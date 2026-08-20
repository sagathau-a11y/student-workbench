# 学员管理工作台 — 部署镜像（Node 常驻 + HTTPS 由平台提供）
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# 先装依赖（利用缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 只拷贝运行需要的文件（不含 node_modules / 数据文件）
COPY index.html styles.css app.js sw.js manifest.webmanifest icon-192.png icon-512.png server.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
