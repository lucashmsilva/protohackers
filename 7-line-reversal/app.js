const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');

// /connect/SESSION/
// /data/SESSION/POS/DATA/
// /ack/SESSION/LENGTH/
// /close/SESSION/

const PORT = 6767;
const clients = {};
// 123456: { // sessionId
//   address: '123.345.567.678'
//   port: 12345,
//   sessionOpen: true
// }

server.on('error', (err) => {
  console.error(`server error:\n${err.stack}`);
  server.close();
});

server.on('message', (buffer, rinfo) => {
  const msg = Buffer.from(buffer).toString('ascii');
  console.log(`${rinfo.address}:${rinfo.port} | message recieved ${msg}`);

  let messageParts = msg.split('/');
  messageParts.pop();
  messageParts.shift();

  const messageType = messageParts.shift();
  const sessionId = messageParts.shift();
  const { address, port } = rinfo;
  console.log('>>>>>>>>>>>>>>>>', messageType);

  switch (messageType) {
    case 'connect':
      clients[sessionId] = {
        address, port,
        sessionOpen: true
      }
      // emit connect

      server.send(Buffer.from(`/ack/${sessionId}/0/`), port, address);
      break;

    case 'data':
      const dataPosition = messageParts.shift();
      const payload = messageParts.shift();
      console.log('data message', dataPosition, payload);
      // stream.write(payload);
      break;

    case 'ack':
      const ackPosition = messageParts.join('/')
      console.log('ack message', sessionId, ackPosition);

      break;

    case 'close':
      console.log('close message', sessionId);

      break;

    default:
      break;
  }

});

server.on('listening', () => {
  console.log(`server started on ${PORT}`);
});

server.bind(PORT);