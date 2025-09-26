// server.js

const ROLES = {
    MERLIN: 'Merlin',
    PERCIVAL: 'Percival',
    LOYAL_SERVANT: 'Loyal_Servant',
    MORGANA: 'Morgana',
    ASSASSIN: 'Assassin',
    MORDRED: 'Mordred',
    MINION: 'Minion',
    OBERON: 'Oberon'
};

const ALIGNMENT = {
    GOOD: 'good',
    EVIL: 'evil'
};
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let rooms = {};

// Game Configurations
const gameSetups = {
    5: { roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN], missionTeam: [2, 3, 2, 3, 3] },
    6: { roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN], missionTeam: [2, 3, 4, 3, 4] },
    7: { roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.OBERON], missionTeam: [2, 3, 3, 4, 4], twoFailsRequired: true },
    8: { roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MINION], missionTeam: [3, 4, 4, 5, 5], twoFailsRequired: true },
    9: { roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MORDRED], missionTeam: [3, 4, 4, 5, 5], twoFailsRequired: true },
    10: { roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MORDRED, ROLES.OBERON], missionTeam: [3, 4, 4, 5, 5], twoFailsRequired: true },
};

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    socket.on('createRoom', ({ playerName }) => {
        let roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        while (rooms[roomId]) { roomId = Math.random().toString(36).substring(2, 7).toUpperCase(); }
        rooms[roomId] = { players: [], gameState: { status: 'lobby' } };
        socket.emit('roomCreated', roomId);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        if (!rooms[roomId]) { socket.emit('error', '房间不存在'); return; }
        if (rooms[roomId].gameState.status !== 'lobby') { socket.emit('error', '游戏已开始，无法加入'); return; }
        joinRoom(socket, roomId, playerName);
        socket.emit('joinSuccess', roomId);
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.players[0]?.id) { socket.emit('error', '只有房主可以开始游戏'); return; }
        const numPlayers = room.players.length;
        if (!gameSetups[numPlayers]) { socket.emit('error', `不支持 ${numPlayers} 人游戏 (请选择 5-10 人)`); return; }
        initializeGame(roomId);
    });

    socket.on('proposeTeam', ({roomId, team}) => {
        const room = rooms[roomId];
        if(!room) return;
        room.gameState.proposedTeam = team;
        room.gameState.status = 'voting';
        room.gameState.votes = {};
        io.to(roomId).emit('gameStateUpdate', room.gameState);
    });

    socket.on('voteOnTeam', ({roomId, vote}) => {
        const room = rooms[roomId];
        if(!room) return;
        room.gameState.votes[socket.id] = vote;

        if(Object.keys(room.gameState.votes).length === room.players.length) {
            const approvals = Object.values(room.gameState.votes).filter(v => v === 'approve').length;
            const passed = approvals > room.players.length / 2;

            const logEntry = {
                type: 'proposal',
                quest: room.gameState.missionRound + 1,
                proposal: room.gameState.voteTrack + 1,
                leader: room.players[room.gameState.leaderIndex].name,
                team: room.gameState.proposedTeam.map(id => room.players.find(p => p.id === id).name),
                votes: { ...room.gameState.votes },
                result: passed ? 'passed' : 'failed'
            };
            room.gameState.gameLog.push(logEntry);

            if(passed) {
                room.gameState.status = 'mission';
                room.gameState.missionVotes = {};
            } else {
                room.gameState.voteTrack++;
                if (room.gameState.voteTrack >= 5) { endGame(roomId, 'evil', '队伍连续5次投票失败'); return; }
                nextLeader(room);
                room.gameState.status = 'proposing';
            }
            io.to(roomId).emit('voteResult', { votes: room.gameState.votes, passed });
            setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 3000);
        }
    });

    socket.on('voteOnMission', ({roomId, vote}) => {
        const room = rooms[roomId];
        if(!room) return;
        room.gameState.missionVotes[socket.id] = vote;

        const teamSize = gameSetups[room.players.length].missionTeam[room.gameState.missionRound];
        if(Object.keys(room.gameState.missionVotes).length === teamSize) {
            const fails = Object.values(room.gameState.missionVotes).filter(v => v === 'fail').length;
            const twoFailsNeeded = gameSetups[room.players.length].twoFailsRequired && room.gameState.missionRound === 3;
            const missionFailed = fails > 0 && (!twoFailsNeeded || fails > 1);
            
            room.gameState.missionResults.push(missionFailed ? 'fail' : 'success');
            
            io.to(roomId).emit('missionResult', { result: room.gameState.missionResults.slice(-1)[0], fails });
            
            const totalFails = room.gameState.missionResults.filter(r => r === 'fail').length;
            const totalSuccesses = room.gameState.missionResults.filter(r => r === 'success').length;

            if (totalFails >= 3) { endGame(roomId, 'evil', '3次任务失败'); return; }
            if (totalSuccesses >= 3) {
                const goodPlayers = room.players.filter(p => p.alignment === ALIGNMENT.GOOD);
                room.gameState.assassinationTargets = goodPlayers.map(p => ({ id: p.id, name: p.name }));
                room.gameState.status = 'assassination';
                io.to(roomId).emit('gameStateUpdate', room.gameState);
                return;
            }

            const ladyQuests = [1, 2, 3]; // Quests 2, 3, 4 (0-indexed)
            if (room.gameState.ladyOfTheLake && ladyQuests.includes(room.gameState.missionRound)) {
                room.gameState.status = 'ladyOfTheLake';
                setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 4000);
            } else {
                startNextRound(room, roomId); // ✨ **FIX**: Pass roomId
            }
        }
    });

    socket.on('useLadyOfTheLake', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState.ladyOfTheLake || socket.id !== room.gameState.ladyOfTheLake.holderId) {
            return;
        }
        
        const targetPlayer = room.players.find(p => p.id === targetId);
        if (!targetPlayer || room.gameState.ladyOfTheLake.previousHolders.includes(targetId)) {
            socket.emit('error', '无效的目标');
            return;
        }

        const alignment = targetPlayer.alignment;
        io.to(socket.id).emit('ladyOfTheLakeResult', {
            targetName: targetPlayer.name,
            alignment: alignment
        });

        const oldHolderName = room.players.find(p => p.id === socket.id).name;
        const logEntry = {
            type: 'ladyOfTheLake',
            quest: room.gameState.missionRound + 1,
            oldHolder: oldHolderName,
            checkedPlayer: targetPlayer.name
        };
        room.gameState.gameLog.push(logEntry);

        room.gameState.ladyOfTheLake.previousHolders.push(socket.id);
        room.gameState.ladyOfTheLake.holderId = targetId;

        startNextRound(room, roomId); // ✨ **FIX**: Pass roomId
    });

    socket.on('assassinate', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.players.find(p => p.id === socket.id)?.role !== ROLES.ASSASSIN) { return; }
        const targetPlayer = room.players.find(p => p.id === targetId);
        if (targetPlayer.role === ROLES.MERLIN) { endGame(roomId, 'evil', '刺客成功刺杀了梅林！'); } 
        else { endGame(roomId, 'good', '刺客没能找到梅林，好人胜利！'); }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex > -1) {
                room.players.splice(playerIndex, 1);
                if (room.players.length === 0) { delete rooms[roomId]; } 
                else {
                    io.to(roomId).emit('playerLeft', { players: room.players });
                    if (room.gameState.status !== 'lobby') { endGame(roomId, null, '有玩家掉线，游戏结束'); }
                }
                break;
            }
        }
    });
});

function joinRoom(socket, roomId, playerName) {
    socket.join(roomId);
    rooms[roomId].players.push({ id: socket.id, name: playerName });
    socket.data.roomId = roomId;
    io.to(roomId).emit('playerJoined', { players: rooms[roomId].players });
}

function initializeGame(roomId) {
    const room = rooms[roomId];
    const numPlayers = room.players.length;
    const setup = gameSetups[numPlayers];

    let rolesToAssign = [...setup.roles].sort(() => Math.random() - 0.5);
    const evilRoles = [ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MORDRED, ROLES.MINION, ROLES.OBERON];

    room.players.forEach((player, i) => {
        player.role = rolesToAssign[i];
        player.alignment = evilRoles.includes(player.role) ? ALIGNMENT.EVIL : ALIGNMENT.GOOD;
    });

    room.players.forEach(player => {
        const evilPlayers = room.players.filter(p => p.alignment === ALIGNMENT.EVIL);
        let roleInfo = { description: '', players: [] };
        switch (player.role) {
            case ROLES.MERLIN:
                roleInfo.description = '你知道以下玩家是坏人:';
                roleInfo.players = evilPlayers.filter(p => p.role !== ROLES.MORDRED).map(p => p.name);
                break;
            case ROLES.PERCIVAL:
                roleInfo.description = '你看到以下两位玩家是梅林和莫甘娜 (顺序随机):';
                roleInfo.players = room.players.filter(p => p.role === ROLES.MERLIN || p.role === ROLES.MORGANA).map(p => p.name).sort(() => Math.random() - 0.5);
                break;
            case ROLES.MORGANA: case ROLES.ASSASSIN: case ROLES.MINION: case ROLES.MORDRED:
                roleInfo.description = '你的坏人同伙是:';
                roleInfo.players = evilPlayers.filter(p => p.role !== ROLES.OBERON && p.name !== player.name).map(p => p.name);
                break;
        }
        io.to(player.id).emit('roleAssigned', { role: player.role, alignment: player.alignment, roleInfo });
    });

    const firstLeaderIndex = Math.floor(Math.random() * numPlayers);
    
    room.gameState = {
        status: 'proposing',
        players: room.players.map(p => ({id: p.id, name: p.name})),
        missionRound: 0,
        leaderIndex: firstLeaderIndex,
        voteTrack: 0,
        missionResults: [],
        gameLog: [],
        ladyOfTheLake: null,
        setup: { missionTeam: setup.missionTeam, twoFailsRequired: !!setup.twoFailsRequired }
    };

    if (numPlayers >= 8) {
        const ladyHolderIndex = (firstLeaderIndex - 1 + numPlayers) % numPlayers;
        const ladyHolderId = room.players[ladyHolderIndex].id;
        room.gameState.ladyOfTheLake = {
            holderId: ladyHolderId,
            previousHolders: [ladyHolderId]
        };
    }

    io.to(roomId).emit('gameStarted');
    setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 1000);
}

function nextLeader(room) {
    room.gameState.leaderIndex = (room.gameState.leaderIndex + 1) % room.players.length;
}

// ✨ **FIX**: Function now accepts roomId
function startNextRound(room, roomId) {
    room.gameState.missionRound++;
    room.gameState.voteTrack = 0;
    nextLeader(room);
    room.gameState.status = 'proposing';
    // ✨ **FIX**: Use the correct roomId variable
    setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 4000);
}

function endGame(roomId, winner, reason) {
    const room = rooms[roomId];
    if(!room) return;
    room.gameState.status = 'finished';
    io.to(roomId).emit('gameOver', {
        winner,
        reason,
        roles: room.players.map(p => ({name: p.name, role: p.role, alignment: p.alignment}))
    });
    setTimeout(() => { delete rooms[roomId]; }, 60000);
}

server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});