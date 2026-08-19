const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // Лимит 100MB
});

app.use(express.static(__dirname));

const rooms = {}; 

io.on('connection', (socket) => {
    let currentRoomId = null;
    let isGuest = true;
    let username = 'Guest_' + Math.floor(1000 + Math.random() * 9000);

    // Создание комнаты
    socket.on('create-room', ({ roomId, password, maxUsers, defaultPermissions }, callback) => {
        if (rooms[roomId]) {
            return callback({ success: false, message: 'Room already exists' });
        }

        const defaultPerms = defaultPermissions || {
            canUpload: true,
            canDownload: true,
            canDeleteFiles: true,
            canChat: true,
            canViewMessageHistory: true,
            canViewFileHistory: true
        };

        rooms[roomId] = {
            password: password,
            maxUsers: maxUsers || null,
            hostId: socket.id,
            requireAccount: false,
            users: [],
            bannedIds: new Set(),
            bannedUsers: [], 
            permissions: {},
            defaultPermissions: defaultPerms,
            chatHistory: [],
            fileHistory: []
        };

        joinRoom(socket, roomId, username, isGuest, callback);
    });

    // Вход в комнату
    socket.on('join-room', ({ roomId, password }, callback) => {
        const room = rooms[roomId];
        if (!room) {
            return callback({ success: false, message: 'Room not found' });
        }
        if (room.bannedIds.has(socket.id)) {
            return callback({ success: false, message: 'You are banned from this room' });
        }
        if (room.requireAccount && isGuest) {
            return callback({ success: false, message: 'Guests are not allowed in this room' });
        }
        if (room.password !== password) {
            return callback({ success: false, message: 'Incorrect password' });
        }
        if (room.maxUsers && room.users.length >= room.maxUsers) {
            return callback({ success: false, message: 'Room is full' });
        }

        joinRoom(socket, roomId, username, isGuest, callback);
    });

    function joinRoom(socket, roomId, user, guestStatus, callback) {
        socket.join(roomId);
        currentRoomId = roomId;

        const room = rooms[roomId];
        
        // Назначаем хосту полные права, остальным — дефолтные права комнаты
        if (room.hostId === socket.id) {
            room.permissions[socket.id] = {
                canUpload: true,
                canDownload: true,
                canDeleteFiles: true,
                canChat: true,
                canViewMessageHistory: true,
                canViewFileHistory: true
            };
        } else {
            room.permissions[socket.id] = { ...room.defaultPermissions };
        }

        room.users.push({ id: socket.id, name: user, isGuest: guestStatus });

        callback({
            success: true,
            roomId,
            password: room.password,
            maxUsers: room.maxUsers,
            requireAccount: room.requireAccount,
            isHost: room.hostId === socket.id,
            username: user,
            permissions: room.permissions[socket.id],
            chatHistory: room.chatHistory,
            fileHistory: room.fileHistory
        });

        broadcastUserList(roomId);
        socket.to(roomId).emit('sys-message', `${user} joined the room.`);
    }

    function broadcastUserList(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        io.to(roomId).emit('update-users', {
            users: room.users.map(u => ({
                id: u.id,
                name: u.name,
                isGuest: u.isGuest,
                permissions: room.permissions[u.id] || room.defaultPermissions
            })),
            hostId: room.hostId,
            requireAccount: room.requireAccount
        });
    }

    // Обновление настроек комнаты хостом
    socket.on('update-room-settings', ({ requireAccount }) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (socket.id !== room.hostId) return;

        room.requireAccount = requireAccount;

        if (requireAccount) {
            const usersToKick = room.users.filter(u => u.isGuest && u.id !== room.hostId);
            usersToKick.forEach(u => {
                const targetSocket = io.sockets.sockets.get(u.id);
                if (targetSocket) {
                    targetSocket.emit('kicked', 'Guests are not allowed in this room.');
                    targetSocket.leave(currentRoomId);
                }
                room.users = room.users.filter(usr => usr.id !== u.id);
                delete room.permissions[u.id];
            });
        }

        broadcastUserList(currentRoomId);
    });

    // Получение черного списка
    socket.on('get-blacklist', (callback) => {
        if (!currentRoomId || !rooms[currentRoomId]) return callback([]);
        const room = rooms[currentRoomId];
        callback(room.bannedUsers || []);
    });

    // Разбан пользователя
    socket.on('unban-user', (targetId, callback) => {
        if (!currentRoomId || !rooms[currentRoomId]) return callback({ success: false });
        const room = rooms[currentRoomId];

        if (socket.id !== room.hostId) return callback({ success: false, message: 'Only host can unban' });

        room.bannedIds.delete(targetId);
        room.bannedUsers = room.bannedUsers.filter(u => u.id !== targetId);

        callback({ success: true });
    });

    // Чат
    socket.on('send-chat', (text) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const userPerms = room.permissions[socket.id];

        if (userPerms && !userPerms.canChat) {
            return socket.emit('sys-message', 'You do not have permission to send chat messages.');
        }

        const msgObj = { author: username, text };
        room.chatHistory.push(msgObj);

        io.to(currentRoomId).emit('chat-message', msgObj);
    });

    // Передача файла
    socket.on('send-file', (fileData) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const userPerms = room.permissions[socket.id];

        if (userPerms && !userPerms.canUpload) {
            return socket.emit('sys-message', 'You do not have permission to upload files.');
        }

        const fileObj = {
            fileId: fileData.fileId,
            fileName: fileData.fileName,
            fileType: fileData.fileType,
            fileBuffer: fileData.fileBuffer,
            sender: username
        };
        room.fileHistory.push(fileObj);

        io.to(currentRoomId).emit('receive-file', fileObj);
    });

    // Удаление файла
    socket.on('delete-file', ({ fileId }) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const userPerms = room.permissions[socket.id];

        if (userPerms && !userPerms.canDeleteFiles) {
            return socket.emit('sys-message', 'You do not have permission to delete files.');
        }

        room.fileHistory = room.fileHistory.filter(f => f.fileId !== fileId);
        io.to(currentRoomId).emit('file-deleted', { fileId });
    });

    // Обновление прав хостом
    socket.on('update-permissions', ({ targetId, permissions }) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (socket.id !== room.hostId) return;

        if (room.permissions[targetId]) {
            room.permissions[targetId] = permissions;
            io.to(targetId).emit('permissions-updated', permissions);
            broadcastUserList(currentRoomId);
        }
    });

    // Кик пользователя
    socket.on('kick-user', (targetId) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (socket.id !== room.hostId) return;

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.emit('kicked', 'You were kicked from the room by the host.');
            targetSocket.leave(currentRoomId);
        }
        room.users = room.users.filter(u => u.id !== targetId);
        delete room.permissions[targetId];
        broadcastUserList(currentRoomId);
    });

    // Бан пользователя
    socket.on('ban-user', (targetId) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (socket.id !== room.hostId) return;

        const userObj = room.users.find(u => u.id === targetId);
        if (userObj) {
            room.bannedIds.add(targetId);
            room.bannedUsers.push({ id: targetId, name: userObj.name });
        }

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.emit('banned', 'You were banned from this room.');
            targetSocket.leave(currentRoomId);
        }
        room.users = room.users.filter(u => u.id !== targetId);
        delete room.permissions[targetId];
        broadcastUserList(currentRoomId);
    });

    // Отключение
    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            room.users = room.users.filter(u => u.id !== socket.id);
            delete room.permissions[socket.id];

            if (room.users.length === 0) {
                delete rooms[currentRoomId];
            } else {
                if (room.hostId === socket.id) {
                    room.hostId = room.users[0].id;
                }
                broadcastUserList(currentRoomId);
                io.to(currentRoomId).emit('sys-message', `${username} left the room.`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});