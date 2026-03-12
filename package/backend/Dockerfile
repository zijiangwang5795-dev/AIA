FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

# 创建 public 目录用于托管前端
RUN mkdir -p public

EXPOSE 3000

# 启动前先跑迁移
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
