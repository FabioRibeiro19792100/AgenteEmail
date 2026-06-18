FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY public ./public
COPY src ./src
COPY .env.example ./.env.example
COPY data/.gitkeep ./data/.gitkeep

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
