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

function disconnectClient(client, errorMessage) {
  const { id, heartbeatTimer, clientConn } = client;

  console.log(`${id} | client disconnected`);

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  if (errorMessage) {
    sendError(client, errorMessage);
  }

  if (client.type === MESSAGE_IDS.IAMCAMERA) {
    delete cameras[id];
  }

  if (client.type === MESSAGE_IDS.IAMDISPATCHER) {
    delete dispatchers[id];
  }

  clientConn.destroy();
  delete clients[id];
}

function handleClient(client) {
  const { id, clientConn } = client;
  let [
    messageBuffer, // stores the raw message buffer
    currentMessageType, // stores the message type beeing processed
    currentMessagePayload // stores the decoded payload beeing processed.
  ] = resetClientMessageVariables();

  clientConn.on('data', (chunk) => {
    messageBuffer = Buffer.concat([messageBuffer, chunk]); // concat the previous read buffer with the current read chunk

    if (!currentMessageType) { // if currentMessageType is not set, it means a new message is beeing read. So it reads the first u8 to get the message type
      currentMessageType = Buffer.from(chunk).readUInt8();
      messageBuffer = Buffer.from(chunk).subarray(1); // overrides the current message buffer with the rest of the chunk (chunk minus the first u8 that was read)

      console.log(`${id} | message type ${currentMessageType}`);
    }

    try {
      switch (currentMessageType) {
        case MESSAGE_IDS.WANTHEARTBEAT:
          console.log(`${id} | processing WantHeartbeat message`, messageBuffer);
          const WANTHEARTBEAT_PAYLOAD_SIZE = 4; // interval (u32);

          currentMessagePayload = {
            interval: messageBuffer.readUInt32BE()
          };

          console.log(`${id} | WantHeartbeat payload ${JSON.stringify(currentMessagePayload)}`);
          handleHeartbeat(client, currentMessagePayload);

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
          handleCamera(client, currentMessagePayload);

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

          if (!currentMessagePayload.plate_size >= 0) {
            currentMessagePayload = {
              plate_size: messageBuffer.readUInt8(),
            }
            messageBuffer = Buffer.from(messageBuffer).subarray(1);
          }

          const PLATE_STR_PAYLOAD_SIZE = currentMessagePayload.plate_size; // str.length (u8)
          if (messageBuffer.byteLength < PLATE_STR_PAYLOAD_SIZE) {
            return;
          }

          currentMessagePayload.plate = decodeStr(PLATE_STR_PAYLOAD_SIZE, messageBuffer);
          currentMessagePayload.timestamp = messageBuffer.readUInt32BE(PLATE_STR_PAYLOAD_SIZE);

          console.log(`${id} | Plate payload' ${JSON.stringify(currentMessagePayload)}`);
          // handlePlate();

          [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(messageBuffer, PLATE_STR_PAYLOAD_SIZE + 4); // plate.str (u8[]) + timestamp (u32)
          break;

        default:
          throw new Error('illegal msg type');
      }
    } catch (error) {
      disconnectClient(client, error.message);
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

function handleCamera(client, cameraPayload) {
  const { id } = client;

  if (cameras[id]) {
    throw new Error(`client ${id} already registered`);
  }

  client.type = MESSAGE_IDS.IAMCAMERA;
  cameras[id] = {
    ...cameraPayload,
    readings: {}
  }
}

function handlePlateReading(client, platePayload) {
  // v = d/t*3600
  const { id } = client;
  const { plate, timestamp } = platePayload;

  if (!cameras[id].readings[plate]) {
    cameras[id].readings[plate] = [];
  }

  cameras[id].readings[plate].push(timestamp);
  cameras[id].readings[plate].sort().reverse();

  // checkSpeedLimit()
  // dispatchTicket()
}

function resetClientMessageVariables(currentBuffer, readMessageSize) {
  const messagetype = null;
  const messagePayload = {};
  let messageBuffer = Buffer.alloc(0);

  if (currentBuffer?.byteLength > readMessageSize) {
    messageBuffer = Buffer.from(currentBuffer).subarray(readMessageSize);
  }

  return [messageBuffer, messagetype, messagePayload];
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
  asciiChars.forEach((c, i) => buffer.writeUint8(c, 1 + i));

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