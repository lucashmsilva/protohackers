const net = require('net');

const PORT = 6767;

let connectedClients = 0;
let onlineClients = [];

function setupServer(connectionHandler) {
  const server = net.createServer()
    .listen(PORT, () => {
      console.log(`server started on ${PORT}`);
    });

  server.on('connection', (socket) => {
    let onlineClients = [];
    connectionHandler(socket, { onlineClients });
  });
}

async function connectionHandler(socket) {
  const sessionId = `${socket.remoteAddress}:${socket.remotePort}`;
  connectedClients++;

  console.log(`client ${connectedClients} connected from ${sessionId}`);

  socket.on('error', (err) => {
    console.log(`${sessionId} | error ${err}`);
  });

  socket.on('close', () => {
    let disconnectedClient = onlineClients.find(client => client.sessionId === sessionId);
    handleDisconnect(disconnectedClient);
    console.log(`${sessionId} | clients online after disconnect ${onlineClients.length}`);
  });

  const newClient = await handleJoin(socket, sessionId);
  console.log(`${sessionId} | clients online now ${onlineClients.length}`);

  handleChat(newClient);
}

function handleDisconnect(disconnectedClient) {
  if (!disconnectedClient) {
    return;
  }

  console.log(`${disconnectedClient.sessionId} | [${disconnectedClient.name}] diconnected`);

  onlineClients = onlineClients.filter(client => client.sessionId !== disconnectedClient.sessionId);

  broadcastMessage(disconnectedClient, getOnDisconnectMessage(disconnectedClient));
}

async function handleJoin(clientSocket, sessionId) {
  let newClient = {
    socket: clientSocket
  };

  sendMessage(newClient, 'What is your name?');

  const name = await new Promise(resolve => {
    let nameBuffer = '';
    clientSocket.once('data', (chunk) => {
      const receivedDataString = Buffer.from(chunk).toString('ascii');
      nameBuffer += receivedDataString;

      if (!receivedDataString.endsWith('\n')) {
        return;
      }

      nameBuffer = nameBuffer.replace(/[\n\r ]/g, '');

      resolve(nameBuffer);
    })
  })

  if (!isNameValid(name)) {
    clientSocket.write('Illegal name\n');
    clientSocket.destroy();
  }

  console.log(`${sessionId} | chosen name ${name}`);

  newClient = {
    ...newClient,
    sessionId,
    name
  };
  onlineClients.push(newClient);

  broadcastMessage(newClient, getOnJoinMessage(newClient));
  sendMessage(newClient, getOnlineClietsMessage(newClient));

  return newClient;
}

function handleChat(curretCLient) {
  const { socket } = curretCLient;

  let messageBuffer = '';
  socket.on('data', (chunk) => {
    const receivedDataString = Buffer.from(chunk).toString('ascii');
    messageBuffer += receivedDataString;

    if (!receivedDataString.endsWith('\n')) {
      return;
    }

    messageBuffer = messageBuffer.replace(/[\n\r]/g, '');

    broadcastMessage(curretCLient, `[${curretCLient.name}] ${messageBuffer}`);

    messageBuffer = '';
  });
}

function isNameValid(name) {
  let nameString = name + '';
  return nameString.length >= 1 && nameString.length <= 16 && nameString.match('[a-zA-Z0-9]+');
}

function broadcastMessage(author, message) {
  onlineClients
    .filter(client => client.name !== author.name)
    .forEach(client => sendMessage(client, message));
}

function sendMessage(receiverCLient, message) {
  console.log(`message sent to [${receiverCLient.name}]:`, message);
  const { socket } = receiverCLient;
  socket.write(`${message}\n`);
}

function getOnJoinMessage(newClient) {
  return `* ${newClient.name} has entered the room.`;
}

function getOnDisconnectMessage(newClient) {
  return `* ${newClient.name} has left the room.`;
}

function getOnlineClietsMessage(newClient) {
  const onlineNames = onlineClients
    .filter(client => client.name !== newClient.name)
    .map(client => client.name)
    .join(', ')
    .trim();

  return onlineNames === '' ? '* The room is empty.' : `* The room contains: ${onlineNames}.`;
}

async function main() {
  setupServer(connectionHandler);
}

main();