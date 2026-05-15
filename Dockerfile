FROM node:22-slim

# Install Python 3 and pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Install Node.js and Python dependencies
RUN npm install && pip3 install --break-system-packages -r requirements.txt

# Expose port (Railway sets PORT env var)
EXPOSE 8787

CMD ["node", "server.js"]