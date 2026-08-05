const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DOCUMENT_PATH = path.join(__dirname, 'collaborative-document.html');

// Store connected users
const connectedUsers = new Map();

// Initialize document file if it doesn't exist
if (!fs.existsSync(DOCUMENT_PATH)) {
    fs.writeFileSync(DOCUMENT_PATH, '', 'utf8');
}

// *** THIS IS THE NEW PART ***
// Serve the copy.html file when a request is made to the root URL (/)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'copy.html'));
});

// Serve static files (like CSS, JS, etc. if you had them in sub-folders)
app.use(express.static(__dirname));

wss.on('connection', ws => {
    console.log('Client connected');

    // Generate unique user ID and store user info
    ws.userId = Math.random().toString(36).substr(2, 9);
    ws.userName = 'User-' + ws.userId.substr(0, 4);

    const userColors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];
    ws.userColor = userColors[Math.floor(Math.random() * userColors.length)];

    const userInfo = {
        id: ws.userId,
        name: ws.userName,
        color: ws.userColor
    };

    connectedUsers.set(ws.userId, userInfo);

    // 1. Send the current document content to the new client
    fs.readFile(DOCUMENT_PATH, 'utf8', (err, data) => {
        if (err) {
            console.error('Failed to read file:', err);
            return;
        }
        ws.send(JSON.stringify({ type: 'load', content: data }));
    });

    // Send updated user list to all clients
    broadcastUsersUpdate();

    // Notify other clients about new user
    wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'user_joined',
                user: userInfo
            }));
        }
    });

    // Send user count
    broadcastUserCount();

    // 2. Listen for changes from clients
    ws.on('message', message => {
        const data = JSON.parse(message);

        if (data.type === 'update') {
            const newContent = data.content;

            // 3. Update the shared document file
            fs.writeFile(DOCUMENT_PATH, newContent, 'utf8', err => {
                if (err) {
                    console.error('Failed to write file:', err);
                    return;
                }

                // 4. Broadcast the new content to all other clients
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'update', content: newContent }));
                    }
                });
            });
        } else if (data.type === 'chat') {
            // Broadcast chat message to all clients
            const chatMessage = {
                type: 'chat',
                userId: data.userId,
                userName: data.userName,
                message: data.message,
                timestamp: data.timestamp
            };

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(chatMessage));
                }
            });
        } else if (data.type === 'user_update') {
            // Update user info
            ws.userName = data.userName;
            connectedUsers.set(data.userId, {
                id: data.userId,
                name: data.userName,
                color: data.userColor
            });

            // Broadcast updated user list to all clients
            broadcastUsersUpdate();
        } else if (data.type === 'typing_start') {
            // Broadcast typing indicator to other clients
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'typing_start',
                        userId: data.userId,
                        userName: data.userName
                    }));
                }
            });
        } else if (data.type === 'typing_stop') {
            // Broadcast typing stop to other clients
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'typing_stop',
                        userId: data.userId
                    }));
                }
            });
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');

        // Remove user from connected users
        connectedUsers.delete(ws.userId);

        // Notify other clients about user leaving
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'user_left',
                    userId: ws.userId
                }));
            }
        });

        // Send updated user count and list
        broadcastUserCount();
        broadcastUsersUpdate();
    });
});

function broadcastUserCount() {
    // Count only open connections
    const count = Array.from(wss.clients).filter(client => client.readyState === WebSocket.OPEN).length;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'user_count', count: count }));
        }
    });
}

function broadcastUsersUpdate() {
    // Clean up disconnected users first
    const activeUserIds = new Set();
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.userId) {
            activeUserIds.add(client.userId);
        }
    });

    // Remove users that are no longer connected
    for (let [userId, user] of connectedUsers) {
        if (!activeUserIds.has(userId)) {
            connectedUsers.delete(userId);
        }
    }

    const users = Array.from(connectedUsers.values());
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'users_update', users: users }));
        }
    });
}

// Clean up disconnected users every 30 seconds
setInterval(() => {
    broadcastUsersUpdate();
    broadcastUserCount();
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});