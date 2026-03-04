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
const getClientIp = (socket) => {
  return socket.handshake.headers['x-forwarded-for'] ||
         socket.handshake.headers['x-real-ip'] ||
         socket.conn.remoteAddress;
};

const broadcastPeers = (io) => {
  // Group peers by IP
  const peersByIp = new Map(); // ip -> array of peerInfo
  
  for (const peer of peers.values()) {
    if (!peersByIp.has(peer.ip)) {
      peersByIp.set(peer.ip, []);
    }
    peersByIp.get(peer.ip).push(peer);
  }

  // For each IP, emit the list of peers on that IP to the sockets on that IP
  for (const [ip, peerList] of peersByIp.entries()) {
    for (const peer of peerList) {
      // Get the socket for this peer
      const socket = io.sockets.sockets.get(peer.id);
      if (socket) {
        // Send the list of ALL peers on this IP to this specific socket
        socket.emit('peer-list', peerList);
      }
    }
  }
};

io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);
  console.log(`User connected: ${socket.id} from IP: ${clientIp}`);
  
  // Track this peer
  peers.set(socket.id, { 
    id: socket.id, 
    name: `User-${socket.id.substring(0, 4)}`,
    ip: clientIp,
  });
  
  // Send the user their own ID
  socket.emit('your-id', socket.id);

  // Broadcast the updated list of peers to everyone
  broadcastPeers(io);

  socket.on('update-name', (name) => {
    const peer = peers.get(socket.id);
    if (peer) {
      peer.name = name;
      peers.set(socket.id, peer);
      broadcastPeers(io);
    }
  });

  // Relay signaling data (offer, answer, candidates)
  socket.on('signal', (data) => {
    const { targetId, signalData } = data;
    // Security check: Only allow signaling if both peers have the same IP
    const senderPeer = peers.get(socket.id);
    const targetPeer = peers.get(targetId);
    
    if (senderPeer && targetPeer && senderPeer.ip === targetPeer.ip) {
      // Send only to the target device
      io.to(targetId).emit('signal', {
        senderId: socket.id,
        signalData: signalData
      });
    } else {
      console.warn(`Blocked signal attempt between different IPs: ${senderPeer?.ip} -> ${targetPeer?.ip}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    peers.delete(socket.id);
    broadcastPeers(io);
  });
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
