FROM node:20-slim

# poppler-utils provides pdftoppm, used to render a small thumbnail of a
# PDF's first page for uploaded PERA documents (see server.js).
# chromium + fonts render the CARA PDF export from HTML (see cara-pdf.js).
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils chromium fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
