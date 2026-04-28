FROM node:20-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
COPY scripts scripts
RUN yarn install --production --frozen-lockfile

COPY server server
COPY contract contract

ENV ARIZ_DATA_DIR=/data
VOLUME /data

CMD [ "yarn", "start" ]
