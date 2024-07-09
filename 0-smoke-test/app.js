const net = require('net');

const server = net.createServer(function (socket) {
  socket.on('data', data => {
    console.log(Buffer.from(data).toString('utf8'));
    socket.write(data);
  });
});

server.listen(6767, '66.228.43.192');
