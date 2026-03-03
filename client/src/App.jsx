import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const CHUNK_SIZE = 16 * 1024; // 16KB chunks

// When hosted, connect to the exact same origin we are being served from
// If in dev mode, connect to localhost:3001
const SIGNALING_URL = import.meta.env.DEV ? `http://${window.location.hostname}:3001` : window.location.origin;

function App() {
  const [socket, setSocket] = useState(null);
  const [myId, setMyId] = useState('');
  const [peers, setPeers] = useState([]);
  const [transfers, setTransfers] = useState({}); // id -> { file, progress, direction }
  
  // Store active peer connections
  const peerConnections = useRef({});
  const dataChannels = useRef({});
  const incomingFiles = useRef({}); // peerId -> { metadata, chunks, receivedSize }

  useEffect(() => {
    const s = io(SIGNALING_URL);
    setSocket(s);

    s.on('your-id', (id) => {
      setMyId(id);
    });

    s.on('peer-list', (list) => {
      // Filter out self
      setPeers(list.filter(p => p.id !== s.id));
    });

    s.on('signal', async (data) => {
      const { senderId, signalData } = data;
      console.log('Received signal from', senderId, signalData.type);
      
      let pc = peerConnections.current[senderId];
      if (!pc) {
        pc = createPeerConnection(senderId, s);
      }

      if (signalData.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        s.emit('signal', { targetId: senderId, signalData: pc.localDescription });
      } else if (signalData.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData));
      } else if (signalData.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signalData));
        } catch (e) {
          console.error('Error adding received ice candidate', e);
        }
      }
    });

    return () => {
      s.disconnect();
    };
  }, []);

  const createPeerConnection = (targetId, s) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        s.emit('signal', {
          targetId: targetId,
          signalData: event.candidate
        });
      }
    };

    // Handle incoming data channels
    pc.ondatachannel = (event) => {
      const receiveChannel = event.channel;
      receiveChannel.binaryType = 'arraybuffer';
      setupDataChannel(receiveChannel, targetId);
      dataChannels.current[targetId] = receiveChannel;
    };

    peerConnections.current[targetId] = pc;
    return pc;
  };

  const setupDataChannel = (channel, peerId) => {
    channel.onopen = () => console.log('Data channel open with', peerId);
    channel.onclose = () => {
      console.log('Data channel closed with', peerId);
      delete dataChannels.current[peerId];
      delete peerConnections.current[peerId];
    };
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Metadata message
        const msg = JSON.parse(event.data);
        if (msg.type === 'metadata') {
          console.log('Receiving file metadata', msg.metadata);
          incomingFiles.current[peerId] = {
            metadata: msg.metadata,
            chunks: [],
            receivedSize: 0
          };
          setTransfers(prev => ({
            ...prev,
            [peerId]: {
              fileName: msg.metadata.name,
              progress: 0,
              direction: 'receiving'
            }
          }));
        } else if (msg.type === 'eof') {
          // End of file
          const fileData = incomingFiles.current[peerId];
          const blob = new Blob(fileData.chunks, { type: fileData.metadata.type });
          downloadBlob(blob, fileData.metadata.name);
          setTransfers(prev => ({
            ...prev,
            [peerId]: { ...prev[peerId], progress: 100, completed: true }
          }));
          delete incomingFiles.current[peerId];
        }
      } else {
        // Chunk data (ArrayBuffer)
        const fileData = incomingFiles.current[peerId];
        if (fileData) {
          fileData.chunks.push(event.data);
          fileData.receivedSize += event.data.byteLength;
          const progress = Math.round((fileData.receivedSize / fileData.metadata.size) * 100);
          
          setTransfers(prev => {
            // Only update if changed to avoid too many re-renders
            if (prev[peerId]?.progress !== progress) {
              return { ...prev, [peerId]: { ...prev[peerId], progress } };
            }
            return prev;
          });
        }
      }
    };
  };

  const connectToPeer = async (targetId) => {
    if (peerConnections.current[targetId]) return; // Already connecting

    const pc = createPeerConnection(targetId, socket);
    const dataChannel = pc.createDataChannel('fileTransfer');
    dataChannel.binaryType = 'arraybuffer';
    setupDataChannel(dataChannel, targetId);
    dataChannels.current[targetId] = dataChannel;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('signal', { targetId, signalData: pc.localDescription });
  };

  const sendFile = (targetId, file) => {
    const channel = dataChannels.current[targetId];
    // Ensure connection is established before sending
    if (!channel || channel.readyState !== 'open') {
      console.log('Connection not open, attempting to connect first...');
      
      // Auto connect if not connected
      connectToPeer(targetId);
      
      // Set up a listener for when the channel opens
      const checkConnection = setInterval(() => {
        const checkChannel = dataChannels.current[targetId];
        if (checkChannel && checkChannel.readyState === 'open') {
          clearInterval(checkConnection);
          sendFile(targetId, file); // Retry sending
        }
      }, 500);
      
      // Timeout after 10 seconds
      setTimeout(() => clearInterval(checkConnection), 10000);
      return;
    }

    setTransfers(prev => ({
      ...prev,
      [targetId]: { fileName: file.name, progress: 0, direction: 'sending' }
    }));

    // Send metadata first
    const metadata = { name: file.name, size: file.size, type: file.type };
    channel.send(JSON.stringify({ type: 'metadata', metadata }));

    // Send chunks
    let offset = 0;
    const reader = new FileReader();
    
    reader.onload = (e) => {
      if (channel.readyState !== 'open') return;
      
      channel.send(e.target.result);
      offset += e.target.result.byteLength;
      
      const progress = Math.round((offset / file.size) * 100);
      setTransfers(prev => ({
        ...prev,
        [targetId]: { ...prev[targetId], progress }
      }));

      if (offset < file.size) {
        readNextChunk();
      } else {
        // EOF
        channel.send(JSON.stringify({ type: 'eof' }));
        setTransfers(prev => ({
          ...prev,
          [targetId]: { ...prev[targetId], progress: 100, completed: true }
        }));
      }
    };

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    readNextChunk();
  };

  const downloadBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen p-8 max-w-4xl mx-auto">
      <div className="bg-white rounded-2xl shadow-xl p-8">
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-gray-100">
          <div>
            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">Shivangee's personal assistant</h1>
            <p className="text-gray-500 mt-2">Share files securely over your local network.</p>
          </div>
          <div className="text-right">
            <span className="text-sm text-gray-400 block mb-1">Your ID</span>
            <span className="font-mono bg-gray-100 text-gray-800 py-1 px-3 rounded text-lg font-medium">
              {myId.substring(0, 6)}...
            </span>
          </div>
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-6 flex items-center text-gray-800">
            <span className="bg-blue-100 text-blue-600 w-8 h-8 rounded-full flex items-center justify-center mr-3 text-sm">
              {peers.length}
            </span>
            Available Devices
          </h2>
          
          {peers.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-200">
              <div className="animate-pulse mb-4">
                <svg className="w-12 h-12 text-gray-300 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16l2.879-2.879m0 0a3 3 0 104.243-4.242 3 3 0 00-4.243 4.242zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-gray-500">Waiting for other devices to connect...</p>
              <p className="text-sm text-gray-400 mt-2">Open this app on another device on the same local network.</p>
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {peers.map((peer) => (
                <div key={peer.id} className="bg-white border hover:border-blue-400 transition-colors rounded-xl p-6 shadow-sm relative group overflow-hidden">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-4">
                      <div className="bg-indigo-50 p-3 rounded-full">
                        <svg className="w-6 h-6 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <div>
                        <p className="font-semibold text-gray-800">{peer.name}</p>
                        <p className="text-xs text-gray-400 font-mono mt-1">{peer.id.substring(0, 8)}</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => connectToPeer(peer.id)}
                      className="text-sm bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white transition-colors px-4 py-2 rounded-lg font-medium"
                    >
                      Connect
                    </button>
                  </div>

                  <div className="mt-6 pt-6 border-t border-gray-50">
                    <input 
                      type="file" 
                      id={`file-${peer.id}`} 
                      className="hidden" 
                      onChange={(e) => {
                        if (e.target.files.length > 0) {
                          sendFile(peer.id, e.target.files[0]);
                          e.target.value = null; // reset
                        }
                      }}
                    />
                    <label 
                      htmlFor={`file-${peer.id}`}
                      className="w-full flex items-center justify-center space-x-2 bg-gray-50 hover:bg-gray-100 text-gray-700 py-3 rounded-lg cursor-pointer transition-colors border border-gray-200"
                    >
                      <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <span className="font-medium">Send File</span>
                    </label>
                  </div>

                  {transfers[peer.id] && (
                    <div className="absolute inset-0 bg-white/95 backdrop-blur-sm p-6 flex flex-col justify-center border rounded-xl top-0 left-0 right-0 bottom-0 z-10 transition-opacity">
                      <div className="text-center mb-4">
                        <p className="text-sm font-semibold text-gray-800 truncate mb-1" title={transfers[peer.id].fileName}>
                          {transfers[peer.id].direction === 'sending' ? 'Sending: ' : 'Receiving: '}
                          {transfers[peer.id].fileName}
                        </p>
                        <p className="text-xs text-blue-600 font-medium">{transfers[peer.id].progress}%</p>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                        <div 
                          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out" 
                          style={{ width: `${transfers[peer.id].progress}%` }}
                        ></div>
                      </div>
                      {transfers[peer.id].completed && (
                        <button 
                          onClick={() => {
                            setTransfers(prev => {
                              const newT = {...prev};
                              delete newT[peer.id];
                              return newT;
                            });
                          }}
                          className="mt-4 text-sm text-gray-500 hover:text-gray-800"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
{/* Decorative background elements */}
<div className="fixed top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
  <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-purple-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob"></div>
  <div className="absolute top-[-10%] right-[-10%] w-96 h-96 bg-blue-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-2000"></div>
  <div className="absolute bottom-[-20%] left-[20%] w-96 h-96 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-4000"></div>
</div>
    </div>
  );
}

export default App;
