FROM node:20
WORKDIR /app
COPY package.json package.json
COPY yarn.lock yarn.lock
RUN yarn
COPY server server
CMD [ "yarn", "start" ]
