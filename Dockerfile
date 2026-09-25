# ---- 构建阶段：安装依赖并产出纯静态产物 dist/ ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 静态应用宿主（Compose 的 web 服务） ----
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# 健康检查直接对应“静态应用可用”：首页必须返回应用标记（meta application-name）。
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=12 \
  CMD wget -qO- http://127.0.0.1/ | grep -q 'name="application-name" content="flux-phase-reconciler"' || exit 1

# ---- 复核容器（Compose 的 verify 服务）：测试 + 构建检查 + HTTP 冒烟后退出 ----
FROM node:20-alpine AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["sh", "./scripts/verify.sh"]
