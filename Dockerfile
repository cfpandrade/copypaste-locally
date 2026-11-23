# Use Node.js LTS version
FROM node:22-alpine

LABEL version="3.1.1"
LABEL description="Collaborative copy/paste app with enhanced features"
LABEL maintainer="Carlos Andrade <carlos@perezandrade.com>"
LABEL features="notas-separadas,archivos,qr,chat,dark-mode,search-replace,caducidad,redes-permitidas,app-movil"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create a non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Las notas y los archivos compartidos viven aquí, fuera del código, para que
# se puedan conservar en un volumen sin tapar la aplicación.
ENV DATA_DIR=/datos
RUN mkdir -p /datos && chown -R nodejs:nodejs /app /datos
USER nodejs
VOLUME ["/datos"]

# Expose port 3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# Start the application
CMD ["npm", "start"]