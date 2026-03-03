const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Serve static files from the React app build directory
app.use(express.static(path.join(__dirname, '../client/dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // In production, restrict this
    methods: ['GET', 'POST']
  }
});

const peers = new Map(); // socketId -> peerInfo

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Track this peer
  peers.set(socket.id, { id: socket.id, name: `User-${socket.id.substring(0, 4)}` });
  
  // Send the user their own ID
  socket.emit('your-id', socket.id);

  // Broadcast the updated list of peers to everyone
  const peerList = Array.from(peers.values());
  io.emit('peer-list', peerList);

  socket.on('update-name', (name) => {
    const peer = peers.get(socket.id);
    if (peer) {
      peer.name = name;
      peers.set(socket.id, peer);
      io.emit('peer-list', Array.from(peers.values()));
    }
  });

  // Relay signaling data (offer, answer, candidates)
  socket.on('signal', (data) => {
    const { targetId, signalData } = data;
    // Send only to the target device
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signalData: signalData
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    peers.delete(socket.id);
    io.emit('peer-list', Array.from(peers.values()));
  });
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
