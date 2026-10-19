# WorkBuddy 多账号调度网关 · 容器镜像
# 只依赖 Node 22 内置能力，没有任何运行时 npm 依赖，所以镜像很小
FROM node:22-alpine

WORKDIR /app

# 网关本体（无 runtime 依赖，无需 npm install）
COPY package.json ./package.json
COPY server.mjs ./server.mjs
COPY src ./src
COPY web ./web
COPY scripts ./scripts

ENV NODE_ENV=production \
    SIM_HOST=0.0.0.0 \
    SIM_PORT=8787 \
    WBSIM_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SIM_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
