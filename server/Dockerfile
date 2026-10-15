FROM node:22-alpine
WORKDIR /app
# The volume takes this folder's owner on first use, so the node user can write to it.
RUN mkdir /data && chown node:node /data
COPY server.mjs .
USER node
ENV DATA_FILE=/data/state.json PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
