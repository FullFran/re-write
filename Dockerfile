# The review page's scene editor (editor/, docs/deployment.md) is built here and only its output
# (dist/: editor.js, the chunks it imports later and their manifest) is copied into the image;
# the built files are not part of the repository.
FROM node:24-slim AS editor
WORKDIR /editor
COPY editor/package.json editor/package-lock.json ./
RUN npm ci --ignore-scripts
COPY editor/build.mjs ./
COPY editor/src ./src
RUN npm run build

FROM node:24-slim

# The server keeps each book in a git repository.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# The embedded engine (docs/engine.md) is optional and heavy, so it is not installed unless asked
# for: build with --build-arg WITH_ENGINE=1. Without it the image is the same as before.
ARG WITH_ENGINE=0
COPY engine ./engine
RUN if [ "$WITH_ENGINE" = "1" ]; then cd engine && npm ci --omit=dev --ignore-scripts && npm cache clean --force; fi
COPY fixtures ./fixtures
COPY --from=editor /editor/dist ./editor/dist
# COPY keeps the build context's file modes; a checkout made under a strict umask would leave
# files the node user cannot read.
RUN chmod -R a+rX /app

# Pre-create the data directory, so a new named volume inherits this owner.
RUN mkdir -p /data && chown node:node /data
USER node
ENV REWRITE_DATA_DIR=/data
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server/main.ts"]
