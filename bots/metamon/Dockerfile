# Frontier adapter for the Metamon Kadabra3 neural policy.
#
# Build:  docker build -t frontier-metamon ./bots/metamon
# Digest: docker inspect --format='{{.Id}}' frontier-metamon
#
# Notes:
# - onnxruntime-node's install script would fetch CUDA EP binaries from NuGet;
#   we only need the bundled CPU binaries, so that download is skipped.
# - The ~94MB fp16 KV-cache model is fetched from the battle-dome site at
#   build time and baked into the image.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# onnxruntime-node's install script fetches CUDA EP binaries from NuGet;
# we only need the bundled CPU binaries, so skip that download.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY metamon/ ./metamon/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ADD https://caedonhsieh.github.io/battle-dome/models/kadabra3_kv_fp16_b2_noeinsum.onnx /model/model.onnx
ENV MODEL_PATH=/model/model.onnx
ENTRYPOINT ["node", "dist/src/adapter.js"]
