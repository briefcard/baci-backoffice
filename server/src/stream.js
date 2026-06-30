// Server-Sent Events fan-out. Each connected rep device holds one /api/stream connection;
// inventory webhooks broadcast deltas to all of them within seconds.
const clients = new Set();

export function addClient(raw) {
  clients.add(raw);
  raw.on('close', () => clients.delete(raw));
}

export function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const raw of clients) {
    try {
      raw.write(payload);
    } catch {
      clients.delete(raw);
    }
  }
}

export function clientCount() {
  return clients.size;
}
