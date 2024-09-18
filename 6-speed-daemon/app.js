const net = require('net');

const PORT = 6767;
const cameras = [];
const dispatchers = [];
const clients = [];

const MESSAGE_IDS = {
  ERROR: 0x10,
  PLATE: 0x20,
  TICKET: 0x21,
  WANTHEARTBEAT: 0x40,
  HEARTBEAT: 0x41,
  IAMCAMERA: 0x80,
  IAMDISPATCHER: 0x81,
};


function setupServer(connectionHandler) {
  const server = net.createServer()
    .listen(PORT, () => {
      console.log(`server started on ${PORT}`);
    });

  server.on('connection', (clientConn) => {
    connectionHandler(clientConn);
  });
}

async function connectionHandler(clientConn) {
  const sessionId = `${clientConn.remoteAddress}:${clientConn.remotePort}`;
  console.log(`${sessionId} | client connected`);
  const client = {
    id: sessionId,
    type: '',
    clientConn: clientConn
  };

  clients[sessionId] = client;

  clientConn.on('error', (err) => {
    console.log(`${sessionId} | error ${err}`);
  });

  clientConn.on('close', () => {
    disconnectClient(client);
  });

  handleClient(client);
}

function disconnectClient(client) {
  const { id, heartbeatTimer, clientConn } = client;

  console.log(`${id} | client disconnected`);

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  clientConn.destroy();
  delete clients[id];
}

function handleClient(client) {
  const { id, clientConn } = client;
  let messageBuffer = Buffer.alloc(0);
  let currentMessageType = null;
  let currentMessagePayload = {};

  clientConn.on('data', (chunk) => {

    if (!currentMessageType) { // if currentMessageType is set, a message payload is beeing read
      currentMessageType = Buffer.from(chunk).readUInt8();
      console.log(`${id} | message type ${currentMessageType}`);

      if (chunk.byteLength > 1) {
        messageBuffer = Buffer.from(chunk).subarray(1);
      }
    } else {
      messageBuffer = Buffer.concat([messageBuffer, chunk]); // concat the previous read buffer with the current read chunk
    }

    switch (currentMessageType) {
      case MESSAGE_IDS.WANTHEARTBEAT:
        console.log(`${id} | processing WantHeartbeat message`, messageBuffer);
        const WANTHEARTBEAT_PAYLOAD_SIZE = 4; // interval (u32);

        currentMessagePayload = {
          interval: messageBuffer.readUInt32BE()
        };

        console.log(`${id} | WantHeartbeat payload ${JSON.stringify(currentMessagePayload)}`);
        handleHeartbeat(client, currentMessagePayload);

        if (messageBuffer.byteLength > WANTHEARTBEAT_PAYLOAD_SIZE) {
          messageBuffer = Buffer.from(messageBuffer).subarray(WANTHEARTBEAT_PAYLOAD_SIZE);
        } else {
          messageBuffer = Buffer.alloc(0);
        }

        currentMessageType = null;
        currentMessagePayload = {};

        [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(messageBuffer, WANTHEARTBEAT_PAYLOAD_SIZE);
        break;

      case MESSAGE_IDS.IAMCAMERA:
        console.log(`${id} | processing IAmCamera message`, messageBuffer);
        const IAMCAMERA_PAYLOAD_SIZE = 2 + 2 + 2; // road (u16) + mile (u16) + limit (u16);

        if (messageBuffer.byteLength < IAMCAMERA_PAYLOAD_SIZE) {
          return;
        }

        currentMessagePayload = {
          road: messageBuffer.readUInt16BE(),
          mile: messageBuffer.readUInt16BE(2),
          limit: messageBuffer.readUInt16BE(4),
        };

        console.log(`${id} | IAmCamera payload' ${JSON.stringify(currentMessagePayload)}`);
        // handleCamera();

        [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(messageBuffer, IAMCAMERA_PAYLOAD_SIZE);
        break;

      case MESSAGE_IDS.IAMDISPATCHER:
        console.log(`${id} | processing IAmDispatcher message`, messageBuffer);

        if (!currentMessagePayload.numroads) {
          currentMessagePayload = {
            numroads: messageBuffer.readUInt8()
          }
          messageBuffer = Buffer.from(messageBuffer).subarray(1);
        }

        const IAMDISPATCHER_PAYLOAD_SIZE = (currentMessagePayload.numroads || 1) * 2; // numroads (u8) * roads (u16[])
        if (messageBuffer.byteLength < IAMDISPATCHER_PAYLOAD_SIZE) {
          return;
        }

        let roadsRead = 0;
        currentMessagePayload.roads = [];
        while (currentMessagePayload.roads.length < currentMessagePayload.numroads) {
          currentMessagePayload.roads.push(messageBuffer.readUInt16BE(2 * roadsRead));
          roadsRead++;
        }

        console.log(`${id} | IAmDispatcher payload' ${JSON.stringify(currentMessagePayload)}`);
        // handleDispacher();

        [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(messageBuffer, IAMDISPATCHER_PAYLOAD_SIZE);
        break;

      case MESSAGE_IDS.PLATE:
        console.log(`${id} | processing Plate message`, messageBuffer);

        if (!currentMessagePayload.finished_plate_str) {
          currentMessagePayload = {
            finished_plate_str: false,
            plate_size: messageBuffer.readUInt8(),
          }
          messageBuffer = Buffer.from(messageBuffer).subarray(1);
        }

        const PLATE_PAYLOAD_SIZE = currentMessagePayload.plate_size || 1; // str.length (u8)
        if (messageBuffer.byteLength < PLATE_PAYLOAD_SIZE) {
          return;
        }

        // let charsRead = 0;
        // let chars = [];
        // while (chars.length < currentMessagePayload.plate_size) {
        //   chars.push(messageBuffer.readUInt8(charsRead));
        //   charsRead++;
        // }

        currentMessagePayload.plate = decodeStr(currentMessagePayload.plate_size, messageBuffer);

        console.log(`${id} | Plate payload' ${JSON.stringify(currentMessagePayload)}`);
        // handlePlate();

        [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(messageBuffer, PLATE_PAYLOAD_SIZE);
        break;

      default:
        const errorMessage = 'illegal msg';
        sendError(client, errorMessage);
        disconnectClient(client);
        break;
    }

  });
}

function handleHeartbeat(client, wantHeartbeatPayload) {
  const { clientConn } = client;
  const { interval } = wantHeartbeatPayload;

  const heartbeatPaylod = Buffer.alloc(1)
  heartbeatPaylod.writeInt8(0x41);

  if (interval === 0) {
    return;
  }

  client.heartbeatTimer = setInterval(() => clientConn.write(heartbeatPaylod), interval / 10 * 1000);

  return;
}

function resetClientMessageVariables(messageBuffer, messageSize) {
  if (messageBuffer.byteLength > messageSize) {
    messageBuffer = Buffer.from(messageBuffer).subarray(messageSize);
  } else {
    messageBuffer = Buffer.alloc(0);
  }

  const currentMessageType = null;
  const currentMessagePayload = {};

  return [messageBuffer, currentMessageType, currentMessagePayload];
}

function decodeStr(strLength, buffer) {
  let charsRead = 0;
  let chars = [];
  while (chars.length < strLength) {
    chars.push(buffer.readUInt8(charsRead));
    charsRead++;
  }

  return String.fromCharCode(...chars);
}

function encodeStr(str) {
  const asciiChars = [...str].map(c => c.charCodeAt());
  const buffer = Buffer.alloc(1 + asciiChars.length); // str length prefix (u8) + str size (u8[])

  buffer.writeUint8(asciiChars.length);

  for (let i = 0; i < asciiChars.length; i++) {
    buffer.writeUint8(asciiChars[i], 1 + i);
  }

  return buffer;
}

function sendError(client, message) {
  const { clientConn } = client;
  const encodedMessage = encodeStr(message);

  const errorMessageTypePrefix = Buffer.alloc(1);
  errorMessageTypePrefix.writeInt8(MESSAGE_IDS.ERROR);

  const errorPaylod = Buffer.concat([errorMessageTypePrefix, encodedMessage]);

  clientConn.write(errorPaylod);

  return;
}

async function main() {
  setupServer(connectionHandler);
}

main();