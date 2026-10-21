FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=3000
ENV COOKIE_SECURE=true

WORKDIR /app
COPY server.mjs ./server.mjs
COPY dist ./dist

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
