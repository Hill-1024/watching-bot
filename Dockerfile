FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY persona ./persona
COPY config ./config
RUN mkdir -p data
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
