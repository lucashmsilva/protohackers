const net = require('net');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const PORT = 6767;
const MESSAGE_SIZE = 9; // bytes

let connectedClients = 0;



function setupServer(connectionHandler, options) {
  const server = net.createServer()
    .listen(PORT, () => {
      // console.log(`server started on ${PORT}`);
    });

  server.on('connection', (socket) => {
    connectionHandler(socket, options);
  });
}

async function setupDatabase() {
  const db = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  await db.exec(`
    DROP TABLE IF EXISTS prices;
    CREATE TABLE prices (sessionId VARCHAR(255), ts INT, price INT);
    CREATE UNIQUE INDEX clientTimestamp ON prices (sessionId, ts);
  `);

  return db;
}

function connectionHandler(socket, options) {
  const { db } = options;

  const sessionId = `${socket.remoteAddress}:${socket.remotePort}`;
  connectedClients++;
  // console.log(`client ${connectedClients} connected from ${sessionId}`);

  let messageId = 0;
  let messageBuffer = Buffer.alloc(0);

  socket.on('error', (err) => {
    // console.log(`====================== socket error ${err}`);
  })

  socket.on('data', async (chunk) => {
    // console.log(`${sessionId} | ${messageId} | bytes received:`, chunk.byteLength);

    try {
      let messageStartByte = 0;
      let messageEndByte = MESSAGE_SIZE;
      messageBuffer = Buffer.concat([messageBuffer, chunk]);

      // console.log(`${sessionId} | ${messageId} | buffer size:`, messageBuffer.byteLength);

      while (shouldProcessBuffer(messageBuffer, messageEndByte)) {
        const messageToProcess = messageBuffer.subarray(messageStartByte, messageEndByte); // always process the first 9 bytes of the buffer

        const [type, intPos1, intPos2] = parseMessage(messageToProcess);

        // console.log(`${sessionId} | ${messageId} | type:`, type);
        // console.log(`${sessionId} | ${messageId} | intPos1:`, intPos1);
        // console.log(`${sessionId} | ${messageId} | intPos2:`, intPos2);

        const [shouldSendResponse, value] = await processMessage({ sessionId, type, intPos1, intPos2 }, db);

        if (shouldSendResponse) {
          const responseBuffer = Buffer.alloc(4);
          responseBuffer.writeInt32BE(value);

          socket.write(responseBuffer);
        }

        messageBuffer = messageBuffer.subarray(messageEndByte); // discards the first 9 bytes that were processed

        // console.log(`${sessionId} | ${messageId} | new buffer size:`, messageBuffer.byteLength);
      }

      messageId++;
    } catch (err) {
      // console.log(`${sessionId} | ${messageId} | err:`, err);

      socket.write(`${err.message}`);
    }
  });
}


function shouldProcessBuffer(buffer, lastEndByte) {
  return buffer.byteLength >= 9 && lastEndByte <= buffer.byteLength
}

function parseMessage(messageBuffer) {
  try {
    const type = messageBuffer.subarray(0, 1).toString('ascii');
    const intPos1 = messageBuffer.readInt32BE(1); // offsets by message type (1 byte)
    const intPos2 = messageBuffer.readInt32BE(5); // offsets by message type and timestamp (1 + 4 bytes)

    return [type, intPos1, intPos2];
  } catch (err) {
    throw new Error(`failed to parse message ${err.message}`);
  }
}

async function processMessage(data, db) {
  const { sessionId, type, intPos1, intPos2 } = data;

  switch (type) {
    case 'I':
      await db.run(`
        INSERT INTO prices VALUES (? , ? , ?)
        ON CONFLICT DO
        UPDATE SET price = ?;
      `, sessionId, intPos1, intPos2, intPos2);

      return [false, null];

    case 'Q':
      const [{ mean }] = await db.all(`
        SELECT CEIL(AVG(price)) AS mean 
        FROM prices
        WHERE sessionId = ? AND ts BETWEEN ? AND ?
      `, sessionId, intPos1, intPos2);

      // console.log(`${sessionId} | query response:`, mean);
      return [true, mean || 0];

    default:
      throw new Error('unknown message type');
  }
}

async function main() {
  const db = await setupDatabase();
  setupServer(connectionHandler, { db });
}

main();