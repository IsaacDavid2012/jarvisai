FROM node:18-slim

WORKDIR /app

# Install dependencies for Puppeteer / Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libxss1 \
    libasound2 \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    curl \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV TZ=Asia/Kuala_Lumpur

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
