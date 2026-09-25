#!/bin/sh
# Compose verify 容器入口：代码测试 → 构建检查 → HTTP 冒烟。
# 任何一步失败立即以非零退出码退出，使 `docker compose ... up verify`
# 能据退出码报告复核结果；全部成功则自行退出 0。
set -eu

BASE_URL="${WEB_URL:-http://web/}"

echo "== [1/3] 代码测试（node --test，含暴力枚举对照与取消测试） =="
npm test

echo "== [2/3] 构建检查（vite build 产出纯静态应用） =="
npm run build
test -f dist/index.html
# BusyBox/GNU find 均可：用 shell 通配确认全部 Worker bundle 已产出。
ls dist/assets/*.worker-*.js >/dev/null 2>&1

echo "== [3/3] HTTP 冒烟：等待 ${BASE_URL} 静态应用就绪 =="
READY=0
i=0
while [ "$i" -lt 60 ]; do
  if wget -q -O /tmp/index.html "${BASE_URL}" \
     && grep -q 'name="application-name" content="flux-phase-reconciler"' /tmp/index.html; then
    READY=1
    break
  fi
  i=$((i + 1))
  sleep 2
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL: web 服务在超时时间内未返回应用首页" >&2
  exit 1
fi
echo "OK: 首页可达且包含应用标记"

# 首页引用的所有静态资源必须可获取（JS/CSS，含 Worker bundle）。
for asset in $(grep -oE 'assets/[^"]+' /tmp/index.html | sort -u); do
  if wget -q -O "/tmp/$(basename "$asset")" "${BASE_URL%/}/${asset}"; then
    echo "OK: 资源 ${asset}"
  else
    echo "FAIL: 静态资源不可达：${asset}" >&2
    exit 1
  fi
done

# 主 JS chunk 中引用的全部 Worker bundle 必须存在于部署产物中。
MAIN_JS=$(grep -oE 'assets/index-[^"]+\.js' /tmp/index.html | head -1)
wget -q -O /tmp/main.js "${BASE_URL%/}/${MAIN_JS}"
for WORKER_REF in $(grep -oE '[A-Za-z0-9._-]+\.worker-[^"]+\.js' /tmp/main.js | sort -u); do
  if wget -q -O /dev/null "${BASE_URL%/}/assets/${WORKER_REF}"; then
    echo "OK: Worker bundle assets/${WORKER_REF} 可获取"
  else
    echo "FAIL: Worker bundle 不可达：assets/${WORKER_REF}" >&2
    exit 1
  fi
done

# 健康检查端点。
wget -q -O - "${BASE_URL%/}/healthz" | grep -qx ok
echo "OK: /healthz 返回 ok"

echo ""
echo "ALL CHECKS PASSED：测试、构建与 HTTP 冒烟全部成功。"
