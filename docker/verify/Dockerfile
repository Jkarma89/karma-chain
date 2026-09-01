# KarmaChain 验证 / 测试容器（功能 001 / T050）
#
# Node.js 24 LTS + 仓库锁定的 npm 依赖（viem、solc、ajv）。
# 源码（tools/ tests/ blockchain/ specs/）在运行时由 compose 只读挂载到 /workspace，镜像只承载运行时与依赖，
# 因此改代码无需重建镜像；改 package-lock.json 才需要。
FROM node:24-alpine

WORKDIR /workspace
ENV NODE_ENV=production \
    npm_config_update_notifier=false

# 仅复制清单文件：依赖层可缓存，且 .dockerignore 已排除源码
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev

# 默认命令由 compose 覆盖（npm run verify / npm test）
CMD ["npm", "run", "verify"]
