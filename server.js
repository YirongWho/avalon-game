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

// 游戏配置
const gameSetups = {
    5: {
        roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN],
        missionTeam: [2, 3, 2, 3, 3],
    },
    6: {
        roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN],
        missionTeam: [2, 3, 4, 3, 4],
    },
    7: {
        roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.OBERON],
        missionTeam: [2, 3, 3, 4, 4],
        twoFailsRequired: true,
    },
    8: {
        roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MINION],
        missionTeam: [3, 4, 4, 5, 5],
        twoFailsRequired: true,
    },
    9: {
        roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MORDRED],
        missionTeam: [3, 4, 4, 5, 5],
        twoFailsRequired: true,
    },
    10: {
        roles: [ROLES.MERLIN, ROLES.PERCIVAL, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.LOYAL_SERVANT, ROLES.MORGANA, ROLES.ASSASSIN, ROLES.MORDRED, ROLES.OBERON],
        missionTeam: [3, 4, 4, 5, 5],
        twoFailsRequired: true,
    },
};

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    socket.on('createRoom', ({ playerName }) => {
        let roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        while (rooms[roomId]) {
            roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        }
        rooms[roomId] = {
            players: [],
            gameState: { status: 'lobby' }
        };
        socket.emit('roomCreated', roomId);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        if (!rooms[roomId]) {
            socket.emit('error', '房间不存在');
            return;
        }
        if (rooms[roomId].gameState.status !== 'lobby') {
            socket.emit('error', '游戏已开始，无法加入');
            return;
        }
        joinRoom(socket, roomId, playerName);
        socket.emit('joinSuccess', roomId);
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const playerSockets = room.players.map(p => p.id);
        if (socket.id !== playerSockets[0]) {
            socket.emit('error', '只有房主可以开始游戏');
            return;
        }
        const numPlayers = room.players.length;
        if (!gameSetups[numPlayers]) {
            socket.emit('error', `不支持 ${numPlayers} 人游戏 (请选择 5-10 人)`);
            return;
        }

        initializeGame(roomId);
    });

    socket.on('proposeTeam', ({roomId, team}) => {
        console.log(`[房间 ${roomId}] 收到了队伍提案事件，队伍成员:`, team);
        const room = rooms[roomId];
        if(!room) {
            console.error(`[错误] 找不到房间 ${roomId}`);
            return;
        }

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
                quest: room.gameState.missionRound + 1,
                proposal: room.gameState.voteTrack + 1,
                leader: room.players[room.gameState.leaderIndex].name,
                team: room.gameState.proposedTeam.map(id => room.players.find(p => p.id === id).name),
                votes: { ...room.gameState.votes },
                result: passed ? 'passed' : 'failed'
            };
            room.gameState.proposalHistory.push(logEntry);

            if(passed) {
                room.gameState.status = 'mission';
                room.gameState.missionVotes = {};
            } else {
                room.gameState.voteTrack++;
                if (room.gameState.voteTrack >= 5) {
                    endGame(roomId, 'evil', '队伍连续5次投票失败');
                    return;
                }
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

            if (fails > 0 && (!twoFailsNeeded || fails > 1)) {
                room.gameState.missionResults.push('fail');
            } else {
                room.gameState.missionResults.push('success');
            }

            const totalFails = room.gameState.missionResults.filter(r => r === 'fail').length;
            const totalSuccesses = room.gameState.missionResults.filter(r => r === 'success').length;

            if (totalFails >= 3) {
                endGame(roomId, 'evil', '3次任务失败');
                return;
            }
            if (totalSuccesses >= 3) {
                // ✨ **MODIFIED**: Prepare target list for assassin
                const goodPlayers = room.players.filter(p => p.alignment === ALIGNMENT.GOOD);
                room.gameState.assassinationTargets = goodPlayers.map(p => ({ id: p.id, name: p.name }));
                room.gameState.status = 'assassination';
                io.to(roomId).emit('gameStateUpdate', room.gameState);
                return;
            }

            room.gameState.missionRound++;
            room.gameState.voteTrack = 0;
            nextLeader(room);
            room.gameState.status = 'proposing';
            io.to(roomId).emit('missionResult', { result: room.gameState.missionResults.slice(-1)[0], fails });
            setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 4000);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex > -1) {
                room.players.splice(playerIndex, 1);
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    io.to(roomId).emit('playerLeft', { players: room.players });
                    if (room.gameState.status !== 'lobby') {
                        endGame(roomId, null, '有玩家掉线，游戏结束');
                    }
                }
                break;
            }
        }
    });

    socket.on('assassinate', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.players.find(p => p.id === socket.id)?.role !== ROLES.ASSASSIN) {
            return;
        }

        const targetPlayer = room.players.find(p => p.id === targetId);
        if (targetPlayer.role === ROLES.MERLIN) {
            endGame(roomId, 'evil', '刺客成功刺杀了梅林！');
        } else {
            endGame(roomId, 'good', '刺客没能找到梅林，好人胜利！');
        }
    });
});

function joinRoom(socket, roomId, playerName) {
    socket.join(roomId);
    rooms[roomId].players.push({ id: socket.id, name: playerName });
    socket.data.roomId = roomId;
    console.log(`${playerName} joined room ${roomId}`);
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

    const evilPlayers = room.players.filter(p => p.alignment === ALIGNMENT.EVIL);
    
    room.players.forEach(player => {
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
            case ROLES.MORGANA:
            case ROLES.ASSASSIN:
            case ROLES.MINION:
            case ROLES.MORDRED:
                roleInfo.description = '你的坏人同伙是:';
                roleInfo.players = evilPlayers.filter(p => p.role !== ROLES.OBERON && p.name !== player.name).map(p => p.name);
                break;
            case ROLES.OBERON:
                roleInfo.description = '你是奥伯伦，你不知道其他坏人，其他坏人也不知道你。';
                break;
            case ROLES.LOYAL_SERVANT:
                roleInfo.description = '你是忠诚的仆人，你不知道其他人的身份。';
                break;
        }

        const payload = {
            role: player.role,
            alignment: player.alignment,
            roleInfo: roleInfo
        };
        io.to(player.id).emit('roleAssigned', payload);
    });

    room.gameState = {
        status: 'proposing',
        players: room.players.map(p => ({id: p.id, name: p.name})),
        missionRound: 0,
        leaderIndex: Math.floor(Math.random() * numPlayers),
        voteTrack: 0,
        missionResults: [],
        proposalHistory: [],
        setup: {
            missionTeam: setup.missionTeam,
            twoFailsRequired: !!setup.twoFailsRequired
        }
    };

    io.to(roomId).emit('gameStarted');
    setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 1000);
}

function nextLeader(room) {
    room.gameState.leaderIndex = (room.gameState.leaderIndex + 1) % room.players.length;
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
    setTimeout(() => {
        delete rooms[roomId];
    }, 60000);
}

server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});