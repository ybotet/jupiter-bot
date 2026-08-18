const http = require('http');
const fs = require('fs');
const path = require('path');
const { PriceFetcher } = require('./dist/core/monitor/priceFetcher.js');

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const fetcher = new PriceFetcher(200);

fetcher.start();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/prices') {
    try {
      const prices = fetcher.getLatestPrices();
      sendJson(res, prices);
    } catch (error) {
      sendJson(res, { error: error instanceof Error ? error.message : 'Unknown error' });
    }
    return;
  }

  let requestedPath = req.url === '/' ? '/index.html' : req.url;
  requestedPath = requestedPath.split('?')[0];
  const filePath = path.join(publicDir, requestedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, file) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(file);
  });
});

server.listen(PORT, () => {
  console.log(`Price dashboard running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  fetcher.stop();
  server.close(() => process.exit(0));
});
