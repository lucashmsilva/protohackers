const net = require('net');
const isPrime = require('prime-number-check');
const PORT = 6767;

let connectedClients = 0;

const server = net.createServer()
  .listen(PORT, () => {
    console.log(`server started on ${PORT}`);
  });

server.on('connection', (socket) => {
  const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  connectedClients++;
  console.log(`client ${connectedClients} connected from ${clientAddr}`);

  let messageId = 0;
  let messageBuffer = '';

  socket.on('data', data => {
    console.log(`${clientAddr} | ${messageId} | bytes received:`, data.byteLength);

    const jsonString = Buffer.from(data).toString('utf8');


    try {
      messageBuffer += jsonString;

      if (!jsonString.endsWith('\n')) {
        console.log(`${clientAddr} | ${messageId} | buffering`);
        return;
      }

      const requests = messageBuffer.split('\n');
      console.log(`${clientAddr} | ${messageId} | requests to process:`, requests.length);

      for (const req of requests) {
        if (req === '') {
          continue;
        }

        console.log(`${clientAddr} | ${messageId} | processing:`, req);

        const requestJSON = JSON.parse(req);

        if (requestJSON?.method != 'isPrime' || typeof requestJSON?.number !== 'number') {
          throw new Error('malformed request');
        }

        const result = isPrime(requestJSON.number);

        const response = { method: "isPrime", prime: result };
        console.log(`${clientAddr} | ${messageId} | response:`, response);

        socket.write(`${JSON.stringify(response)}\n`);
      }

      messageBuffer = '';
      messageId++;
    } catch (err) {
      console.log(`${clientAddr} | ${messageId} | err:`, err.message);

      socket.write(`${err.message}\n`);
      socket.destroy();
    }
  });
});