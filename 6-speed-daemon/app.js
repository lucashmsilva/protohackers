const net = require('net');

const PORT = 6767;
const cameras = {};
const dispatchers = {};
const clients = {};
const plateReadings = {};
const ticketBacklog = {};

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
    type: null,
    clientConn
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
    const { roadsResposible } = client;
    roadsResposible.forEach(road => delete dispatchers[road][id]); //  fix deletion of dispatcher on disconnect
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

    while (messageBuffer.byteLength > 0) {
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

            [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(currentMessageType, messageBuffer, WANTHEARTBEAT_PAYLOAD_SIZE);
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

            console.log(`${id} | IAmCamera payload ${JSON.stringify(currentMessagePayload)}`);
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

            console.log(`${id} | IAmDispatcher payload ${JSON.stringify(currentMessagePayload)}`);
            handleDispacher(client, currentMessagePayload);

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

            console.log(`${id} | Plate payload ${JSON.stringify(currentMessagePayload)}`);
            handlePlateReading(client, currentMessagePayload);

            [messageBuffer, currentMessageType, currentMessagePayload] = resetClientMessageVariables(messageBuffer, PLATE_STR_PAYLOAD_SIZE + 4); // plate.str (u8[]) + timestamp (u32)
            break;

          default:
            throw new Error('illegal msg type');
        }
      }
      catch (error) {
        console.log(`${id} | Error `, error);
        disconnectClient(client, error.message);
      }
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
  const { id, type } = client;

  if (type) {
    throw new Error(`client ${id} already registered as ${type}`);
  }

  client.type = MESSAGE_IDS.IAMCAMERA;
  cameras[id] = cameraPayload;

  console.log(`${id} | cameras ${JSON.stringify(cameras)}`);
}

function handleDispacher(client, currentMessagePayload) {
  const { id, type } = client;
  const { roads } = currentMessagePayload;

  if (type) {
    throw new Error(`client ${id} already registered as ${type}`);
  }

  client.type = MESSAGE_IDS.IAMDISPATCHER;
  client.roadsResposible = roads;

  for (const road of roads) {
    if (!dispatchers[road]) {
      dispatchers[road] = [];
    }

    dispatchers[road].push(id);

    dispatchTicketBacklog(road);

    console.log(`${id} | dispatchers ${JSON.stringify(dispatchers)}`);
  }
}

function handlePlateReading(client, platePayload) {
  const { id } = client;
  const { plate, timestamp } = platePayload;
  const { road, mile, limit } = cameras[id];

  if (!plateReadings[plate]) {
    plateReadings[plate] = {
      readings: {
        [road]: []
      },
      tickets: {
        [road]: []
      }
    };
  }

  plateReadings[plate].readings[road].push({ mile, timestamp });
  plateReadings[plate].readings[road].sort((r1, r2) => r1.timestamp - r2.timestamp);

  console.log(`${id} | plateReadings ${JSON.stringify(plateReadings)}`);

  const [overspeed, mile1, timestamp1, mile2, timestamp2, speed] = checkSpeedLimit(limit, plateReadings[plate].readings[road]); // v = d/t*3600
  if (!overspeed) {
    return;
  }

  if (plateReadings[plate].tickets[road].find(ticket => ticket === `${mile1}_${timestamp1}_${mile2}_${timestamp2}`)) {
    return;
  }

  dispatchTicket({ plate, road, mile1, timestamp1, mile2, timestamp2, speed });

  plateReadings[plate].tickets[road].push(`${mile1}_${timestamp1}_${mile2}_${timestamp2}`);
}

function checkSpeedLimit(limit, readings) {
  let overspeed = false;

  for (let i = 0; i < readings.length; i++) {
    const [mile1, timestamp1] = Object.values(readings[i]);

    for (let j = i + 1; j < readings.length; j++) {
      const [mile2, timestamp2] = Object.values(readings[j]);

      const distance = Math.abs(mile2 - mile1);
      const time = timestamp2 - timestamp1;
      const speed = distance / time * 3600;

      if (speed > limit) { // rounding
        overspeed = true;
        return [overspeed, mile1, timestamp1, mile2, timestamp2, speed];
      }
    }
  }

  return [overspeed];
}

function dispatchTicket({ plate, road, mile1, timestamp1, mile2, timestamp2, speed }) {
  if (!dispatchers[road]) {
    ticketBacklog[road] = ticketBacklog[road] || [];
    ticketBacklog[road].push({ plate, mile1, timestamp1, mile2, timestamp2, speed });

    return;
  }

  const dispatcherId = dispatchers[road][0];
  sendTicket(clients[dispatcherId], { plate, road, mile1, timestamp1, mile2, timestamp2, speed });
}

function dispatchTicketBacklog(road) {
  const backlogForRoad = ticketBacklog[road];

  if (!backlogForRoad) {
    return;
  }

  backlogForRoad.forEach(ticket => dispatchTicket({ road, ...ticket }));
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

function encodeTicketData({ plate, road, mile1, timestamp1, mile2, timestamp2, speed }) {
  const encodedPlate = encodeStr(plate);
  const encodedTicket = Buffer.alloc(16);

  encodedTicket.writeUint16BE(road);
  encodedTicket.writeUint16BE(mile1, 2); // u16
  encodedTicket.writeUint32BE(timestamp1, 2 + 2); // u16 + u16
  encodedTicket.writeUint16BE(mile2, 2 + 2 + 4); // u16 + u16 + u32
  encodedTicket.writeUint32BE(timestamp2, 2 + 2 + 4 + 2); // u16 + u16 + u32 + u16
  encodedTicket.writeUint16BE(speed * 100, 2 + 2 + 4 + 2 + 4); // u16 + u16 + u32 + u16 + u32

  return Buffer.concat([encodedPlate, encodedTicket]);
}

function sendTicket(client, { plate, road, mile1, timestamp1, mile2, timestamp2, speed }) {
  const { clientConn } = client;
  const encodedTicket = encodeTicketData({ plate, road, mile1, timestamp1, mile2, timestamp2, speed });

  const ticketMessageTypePrefix = Buffer.alloc(1);
  ticketMessageTypePrefix.writeInt8(MESSAGE_IDS.TICKET);

  const ticketPaylod = Buffer.concat([ticketMessageTypePrefix, encodedTicket]);

  clientConn.write(ticketPaylod);
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

function resetClientMessageVariables(currentBuffer, readMessageSize) {
  const messagetype = null;
  const messagePayload = {};
  let messageBuffer = Buffer.alloc(0);

  if (currentBuffer?.byteLength > readMessageSize) {
    messageBuffer = Buffer.from(currentBuffer).subarray(readMessageSize);
  }

  return [messageBuffer, messagetype, messagePayload];
}

async function main() {
  setupServer(connectionHandler);
}

main();