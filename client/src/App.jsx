import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const CHUNK_SIZE = 16 * 1024; // 16KB chunks

// When hosted, connect to the exact same origin we are being served from
// If in dev mode, connect to localhost:3001
const SIGNALING_URL = import.meta.env.DEV ? `http://${window.location.hostname}:3001` : window.location.origin;

function App() {
  const [socket, setSocket] = useState(null);
  const [userName, setUserName] = useState(() => localStorage.getItem('localDropUserName') || '');
  const [myId, setMyId] = useState('');
  const [peers, setPeers] = useState([]);
  const [transfers, setTransfers] = useState({}); // id -> { files: [], currentFileIndex: 0, progress: 0, direction: 'sending'|'receiving' }
  
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

  useEffect(() => {
    if (socket && userName && myId) {
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      const suffix = isMobile ? "'s Phone" : "'s Laptop";
      const deviceName = `${userName}${suffix}`;
      socket.emit('update-name', deviceName);
    }
  }, [socket, userName, myId]);

  const createPeerConnection = (targetId, s) => {
    // Mobile hotspots often enable "AP Isolation", which blocks devices on the same WiFi from talking directly to local IPs.
    // We add a basic STUN server so WebRTC can discover public endpoints to punch through the hotspot's NAT. 
    // The signaling server IP filtering still ensures you only see devices on your hotspot.
    // Once established, the file bytes still flow peer-to-peer, not through Google.
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' } // Fallback STUN
      ]
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
    dataChannel.bufferedAmountLowThreshold = 65536; // 64KB threshold for backpressure
    setupDataChannel(dataChannel, targetId);
    dataChannels.current[targetId] = dataChannel;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('signal', { targetId, signalData: pc.localDescription });
  };

  const sendFiles = (targetId, filesArray) => {
    if (!filesArray || filesArray.length === 0) return;

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
          sendFiles(targetId, filesArray); // Retry sending
        }
      }, 500);
      
      // Timeout after 10 seconds
      setTimeout(() => clearInterval(checkConnection), 10000);
      return;
    }

    setTransfers(prev => ({
      ...prev,
      [targetId]: { 
        files: filesArray, 
        currentFileIndex: 0, 
        fileName: filesArray[0].name, 
        progress: 0, 
        direction: 'sending',
        completed: false
      }
    }));

    sendNextFile(targetId, filesArray, 0);
  };

  const sendNextFile = (targetId, filesArray, index) => {
    if (index >= filesArray.length) {
      // All files sent
      setTransfers(prev => ({
        ...prev,
        [targetId]: { ...prev[targetId], progress: 100, completed: true }
      }));
      return;
    }

    const file = filesArray[index];
    const channel = dataChannels.current[targetId];

    setTransfers(prev => ({
      ...prev,
      [targetId]: { ...prev[targetId], currentFileIndex: index, fileName: file.name, progress: 0 }
    }));

    // Send metadata first
    const metadata = { name: file.name, size: file.size, type: file.type };
    channel.send(JSON.stringify({ type: 'metadata', metadata }));

    // Send chunks
    let offset = 0;
    const reader = new FileReader();

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

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
        // Handle backpressure
        if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            readNextChunk();
          };
        } else {
          readNextChunk();
        }
      } else {
        // EOF for this file
        channel.send(JSON.stringify({ type: 'eof' }));
        // Wait a tiny bit then send next file to avoid overwhelming the channel buffer
        setTimeout(() => {
          sendNextFile(targetId, filesArray, index + 1);
        }, 100);
      }
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
    
    // Clean up memory after a small delay to ensure browser has started downloading
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 1000);
  };

  if (!userName) {
    return (
      <div className="min-h-screen p-8 max-w-md mx-auto flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-xl p-8 w-full z-10">
          <h2 className="text-2xl font-bold mb-4 text-gray-800">Welcome to LocalDrop</h2>
          <p className="text-gray-600 mb-6">Please enter your name to continue.</p>
          <form onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const name = formData.get('name').trim();
            if (name) {
              localStorage.setItem('localDropUserName', name);
              setUserName(name);
            }
          }}>
            <input 
              type="text" 
              name="name"
              placeholder="Your Name (e.g. Ankit)" 
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none mb-4"
              autoFocus
              required
            />
            <button 
              type="submit"
              className="w-full bg-blue-600 text-white font-semibold py-3 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Continue
            </button>
          </form>
        </div>
        <div className="fixed top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-purple-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob"></div>
          <div className="absolute top-[-10%] right-[-10%] w-96 h-96 bg-blue-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-2000"></div>
          <div className="absolute bottom-[-20%] left-[20%] w-96 h-96 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-4000"></div>
        </div>
      </div>
    );
  }

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const myDeviceName = `${userName}${isMobile ? "'s Phone" : "'s Laptop"}`;

  return (
    <div className="min-h-screen p-8 max-w-4xl mx-auto">
      <div className="bg-white rounded-2xl shadow-xl p-8 z-10 relative">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-8 pb-6 border-b border-gray-100 gap-4">
          <div>
            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">LocalDrop</h1>
            <p className="text-gray-500 mt-2">Share files securely over your local network.</p>
          </div>
          <div className="text-left sm:text-right flex-shrink-0">
            <span className="text-sm text-gray-400 block mb-1">Visible as</span>
            <div className="flex items-center gap-2">
              <span className="bg-blue-50 text-blue-700 py-1.5 px-4 rounded-lg text-lg font-medium border border-blue-100">
                {myDeviceName}
              </span>
              <button 
                onClick={() => {
                  localStorage.removeItem('localDropUserName');
                  setUserName('');
                }}
                className="text-gray-400 hover:text-gray-600 p-2 rounded-full hover:bg-gray-100 transition-colors"
                title="Change Name"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
              </button>
            </div>
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
                      multiple
                      onChange={(e) => {
                        if (e.target.files.length > 0) {
                          sendFiles(peer.id, Array.from(e.target.files));
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
                      <span className="font-medium">Send File(s)</span>
                    </label>
                  </div>

                  {transfers[peer.id] && (
                    <div className="absolute inset-0 bg-white/95 backdrop-blur-sm p-6 flex flex-col justify-center border rounded-xl top-0 left-0 right-0 bottom-0 z-10 transition-opacity">
                      <div className="text-center mb-4">
                        <p className="text-sm font-semibold text-gray-800 truncate mb-1" title={transfers[peer.id].fileName}>
                          {transfers[peer.id].direction === 'sending' ? 'Sending: ' : 'Receiving: '}
                          {transfers[peer.id].fileName}
                        </p>
                        {transfers[peer.id].files && transfers[peer.id].files.length > 1 && (
                          <p className="text-xs text-gray-500 mb-1">
                            File {transfers[peer.id].currentFileIndex + 1} of {transfers[peer.id].files.length}
                          </p>
                        )}
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
