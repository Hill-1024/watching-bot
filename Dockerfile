FROM node:22-slim AS deps
WORKDIR /app
# better-sqlite3 需要 glibc 预编译包,故用 slim 而非 alpine(musl 会退化为源码编译)
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY plugins ./plugins
COPY persona ./persona
COPY config ./config
RUN mkdir -p data
EXPOSE 8080
# 同一镜像两种角色:默认主进程;supervisor 由 compose 用 command 覆盖。
# 用本地 tsx(不走 npx,避免运行时联网解析)
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
