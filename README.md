# LocalDrop

A completely private peer-to-peer file sharing application built with React, WebRTC, and Node.js.

## Running the App Globally (via Tunnel)

The application features a built React frontend served via a Node Express server. You can expose it securely to the internet to share files with devices not on your local network.

1. Open a terminal and navigate to the `server` directory:
   ```bash
   cd /Users/ankit/.gemini/antigravity/scratch/p2p-file-sharing/server
   ```
2. Start the Node environment:
   ```bash
   node index.js
   ```
3. Open a **second terminal window** in the same directory and launch `localtunnel`:
   ```bash
   npx localtunnel --port 3001
   ```

It will generate a URL like `https://some-random-words.loca.lt`.
The localtunnel service may ask for a password—this is your **laptop's public IP address**. (You can check this by running `curl ifconfig.me`).

## Running the App Locally (Development)

If you just want to run it on your local Wi-Fi without tunnels:

1. **Start the backend server:**
   ```bash
   cd /Users/ankit/.gemini/antigravity/scratch/p2p-file-sharing/server
   node index.js
   ```
2. **Start the frontend development server:**
   (In a new terminal window)
   ```bash
   cd /Users/ankit/.gemini/antigravity/scratch/p2p-file-sharing/client
   npm run dev -- --host
   ```

You can then access the app via your laptop's local IP address and port `5173` on any device on the same Wi-Fi.
