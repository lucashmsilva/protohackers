const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');

const PORT = 6767;
let kvStore = {
  version: 'Ken\'s Key-Value Store 1.0'
};

server.on('error', (err) => {
  console.error(`server error:\n${err.stack}`);
  server.close();
});

server.on('message', (buffer, rinfo) => {
  const msg = Buffer.from(buffer).toString('ascii');
  console.log(`${rinfo.address}:${rinfo.port} | message recieved ${msg}`);

  if (msg.includes('=') && msg.startsWith('version')) {
    return;
  }

  if (Buffer.from(buffer).byteLength > 1000) {
    return;
  }

  if (msg.includes('=')) {
    const separatorPos = msg.indexOf('=');
    const key = msg.substring(0, separatorPos);
    const value = msg.substring(separatorPos + 1);

    kvStore[key] = value;
  } else {
    const key = msg;
    const value = kvStore[key];
    let response = value !== undefined ? `${key}=${value}` : `${key}=`;
    server.send(Buffer.from(response), rinfo.port, rinfo.address);
  }
});

server.on('listening', () => {
  console.log(`server started on ${PORT}`);
});

server.bind(PORT);