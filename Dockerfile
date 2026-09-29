FROM node:20-slim

# poppler-utils provides pdftoppm, used to render a small thumbnail of a
# PDF's first page for uploaded PERA documents (see server.js).
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
