FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache docker-cli docker-cli-compose bash
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 5055
CMD ["npm", "start"]
