// server.js

// ✨ MODIFICATION START: 引入crypto用于生成唯一的玩家ID
const crypto = require('crypto');
// ✨ MODIFICATION END

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
        // ✨ MODIFICATION START: 玩家加入时生成唯一的playerId并返回给客户端
        const playerId = crypto.randomBytes(8).toString('hex');
        const player = joinRoom(socket, roomId, playerName, playerId);
        socket.emit('joinSuccess', { roomId, playerId, isHost: player.isHost });
    });
    
    // ✨ MODIFICATION START: 增加全新的重连事件
    socket.on('attemptReconnect', ({ roomId, playerId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('reconnectFailed');
            return;
        }

        const player = room.players.find(p => p.playerId === playerId);
        if (player && !player.connected) {
            console.log(`Player ${player.name} (${playerId}) reconnected with new socket ${socket.id}`);
            player.connected = true;
            player.socketId = socket.id;
            socket.join(roomId);

            // 如果是房主重连，清除强制关闭房间的计时器
            if (player.isHost && room.hostDisconnectTimeout) {
                console.log(`Host reconnected, clearing disconnect timeout for room ${roomId}.`);
                clearTimeout(room.hostDisconnectTimeout);
                delete room.hostDisconnectTimeout;
            }

            // ✨ FIX START: 根据游戏状态发送不同的重连信息
        const reconnectData = {
            room: {
                roomId: roomId,
                players: room.players.map(p => ({ playerId: p.playerId, name: p.name, connected: p.connected, isHost: p.isHost }))
            },
            gameState: room.gameState
        };

        // 只有在游戏已经开始的情况下才发送角色信息
        if (room.gameState.status !== 'lobby') {
            reconnectData.playerInfo = {
                role: player.role,
                alignment: player.alignment,
                roleInfo: getRoleInfo(room, player)
            };
        }

        socket.emit('reconnectSuccess', reconnectData);
        // ✨ FIX END

            // 通知其他玩家，此人已重新连接
            io.to(roomId).emit('playerConnectionUpdate', { playerId: player.playerId, connected: true });
        } else {
             // 如果找不到玩家或玩家已连接，则重连失败
            socket.emit('reconnectFailed');
        }
    });
    // ✨ MODIFICATION END

    socket.on('leaveRoom', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        // 从房间中移除玩家
        room.players = room.players.filter(p => p.socketId !== socket.id);

        // 广播更新玩家列表
        io.to(roomId).emit('playerJoined', { players: room.players });

        socket.leave(roomId);
        socket.emit('roomLeft');
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        // ✨ MODIFICATION: 通过socketId找到玩家，再判断是否是房主
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player || !player.isHost) { socket.emit('error', '只有房主可以开始游戏'); return; }
        const numPlayers = room.players.length;
        if (!gameSetups[numPlayers]) { socket.emit('error', `不支持 ${numPlayers} 人游戏 (请选择 5-10 人)`); return; }
        initializeGame(roomId);
    });

    // ✨ MODIFICATION START: 增加房主关闭房间的功能 (仅限大厅)
    socket.on('closeRoom', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (player && player.isHost && room.gameState.status === 'lobby') {
            console.log(`Host ${player.name} closed room ${roomId}`);
            // 通知所有人房间已关闭
            io.to(roomId).emit('roomClosed', '房主关闭了房间');
            delete rooms[roomId];
        }
    });
    // ✨ MODIFICATION END

    // ✨ MODIFICATION START: 增加房主强制结束游戏的功能
    socket.on('forceEndGameByHost', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (player && player.isHost) {
            forceEndGame(roomId, '房主强制结束了游戏');
        }
    });
    // ✨ MODIFICATION END

    // ✨ MODIFICATION START: 重构所有游戏逻辑，使用playerId作为唯一标识符
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
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        room.gameState.votes[player.playerId] = vote;
        const connectedPlayersCount = room.players.filter(p => p.connected).length;

        if(Object.keys(room.gameState.votes).length === connectedPlayersCount) {
            const approvals = Object.values(room.gameState.votes).filter(v => v === 'approve').length;
            const passed = approvals > connectedPlayersCount / 2;

            const logEntry = {
                type: 'proposal',
                quest: room.gameState.missionRound + 1,
                proposal: room.gameState.voteTrack + 1,
                leader: room.players[room.gameState.leaderIndex].name,
                team: room.gameState.proposedTeam.map(pid => room.players.find(p => p.playerId === pid).name),
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
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;
        
        room.gameState.missionVotes[player.playerId] = vote;

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
                room.gameState.assassinationTargets = goodPlayers.map(p => ({ playerId: p.playerId, name: p.name }));
                room.gameState.status = 'assassination';
                io.to(roomId).emit('gameStateUpdate', room.gameState);
                return;
            }

            const ladyQuests = [1, 2, 3];
            if (room.gameState.ladyOfTheLake && ladyQuests.includes(room.gameState.missionRound)) {
                room.gameState.status = 'ladyOfTheLake';
                setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 4000);
            } else {
                startNextRound(room, roomId);
            }
        }
    });

    socket.on('useLadyOfTheLake', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState.ladyOfTheLake) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if(!player || player.playerId !== room.gameState.ladyOfTheLake.holderId) return;
        
        const targetPlayer = room.players.find(p => p.playerId === targetId);
        if (!targetPlayer || room.gameState.ladyOfTheLake.previousHolders.includes(targetId)) {
            socket.emit('error', '无效的目标');
            return;
        }

        io.to(socket.id).emit('ladyOfTheLakeResult', {
            targetName: targetPlayer.name,
            alignment: targetPlayer.alignment
        });

        const logEntry = {
            type: 'ladyOfTheLake',
            quest: room.gameState.missionRound + 1,
            oldHolder: player.name,
            checkedPlayer: targetPlayer.name
        };
        room.gameState.gameLog.push(logEntry);

        room.gameState.ladyOfTheLake.previousHolders.push(player.playerId);
        room.gameState.ladyOfTheLake.holderId = targetId;

        startNextRound(room, roomId);
    });

    socket.on('assassinate', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player || player.role !== ROLES.ASSASSIN) { return; }
        
        const targetPlayer = room.players.find(p => p.playerId === targetId);
        if (targetPlayer.role === ROLES.MERLIN) { endGame(roomId, 'evil', '刺客成功刺杀了梅林！'); } 
        else { endGame(roomId, 'good', '刺客没能找到梅林，好人胜利！'); }
    });
    // ✨ MODIFICATION END

    // ✨ MODIFICATION START: 完全重写断开连接的逻辑
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // 遍历所有房间找到该玩家
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.socketId === socket.id);

            if (playerIndex > -1) {
                const player = room.players[playerIndex];
                player.connected = false;
                player.socketId = null;
                console.log(`Player ${player.name} in room ${roomId} marked as disconnected.`);

                // 广播玩家掉线状态
                io.to(roomId).emit('playerConnectionUpdate', { playerId: player.playerId, connected: false });

                // 如果掉线的是房主，并且游戏已经开始，启动2分钟倒计时
                if (player.isHost && room.gameState.status !== 'lobby') {
                    console.log(`Host disconnected. Starting 2-minute timer for room ${roomId}...`);
                    room.hostDisconnectTimeout = setTimeout(() => {
                        forceEndGame(roomId, '房主已掉线超过2分钟，游戏结束');
                    }, 120000); // 2分钟
                }

                // 如果掉线的是房主，且游戏未开始，启动2分钟倒计时，之后关闭房间
                if (player.isHost && room.gameState.status === 'lobby') {
                    console.log(`Host disconnected from lobby. Starting 2-minute timer to close room ${roomId}...`);
                    room.hostDisconnectTimeout = setTimeout(() => {
                        forceEndGame(roomId, '房主掉线，房间关闭');
                    }, 120000); // 2分钟
                }

                
                break; // 找到后就跳出循环
            }
        }
    });
    // ✨ MODIFICATION END
});

// ✨ MODIFICATION: joinRoom函数增加playerId参数，并标记房主
function joinRoom(socket, roomId, playerName, playerId) {
    socket.join(roomId);
    const isHost = rooms[roomId].players.length === 0; // 第一个加入的玩家是房主
    const playerObj = { 
        playerId, 
        socketId: socket.id, 
        name: playerName, 
        connected: true,
        isHost: isHost 
    };
    rooms[roomId].players.push(playerObj);
    socket.data.roomId = roomId; // 方便以后使用
    // ✨ MODIFICATION: 广播的玩家列表现在包含更详细的信息
    io.to(roomId).emit('playerJoined', { 
        players: rooms[roomId].players.map(p => ({ playerId: p.playerId, name: p.name, connected: p.connected, isHost: p.isHost })) 
    });
    return playerObj;
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
        const roleInfo = getRoleInfo(room, player); // ✨ MODIFICATION: 提取为独立函数
        // ✨ MODIFICATION: 使用socketId单独发送情报
        io.to(player.socketId).emit('roleAssigned', { role: player.role, alignment: player.alignment, roleInfo });
    });

    const firstLeaderIndex = Math.floor(Math.random() * numPlayers);
    
    room.gameState = {
        status: 'proposing',
        // ✨ MODIFICATION: gameState中的players列表也包含更详细信息
        players: room.players.map(p => ({playerId: p.playerId, name: p.name, connected: p.connected, isHost: p.isHost})),
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
        const ladyHolderId = room.players[ladyHolderIndex].playerId; // ✨ MODIFICATION: 使用playerId
        room.gameState.ladyOfTheLake = {
            holderId: ladyHolderId,
            previousHolders: [ladyHolderId]
        };
    }

    io.to(roomId).emit('gameStarted');
    setTimeout(() => io.to(roomId).emit('gameStateUpdate', room.gameState), 1000);
}

// ✨ MODIFICATION START: 提取获取角色情报的逻辑为独立函数，方便重连时调用
function getRoleInfo(room, player) {
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
            roleInfo.players = evilPlayers.filter(p => p.role !== ROLES.OBERON && p.playerId !== player.playerId).map(p => p.name);
            break;
    }
    return roleInfo;
}
// ✨ MODIFICATION END

// ✨ MODIFICATION START: nextLeader函数现在会跳过掉线的玩家
function nextLeader(room) {
    const numPlayers = room.players.length;
    let currentLeaderIndex = room.gameState.leaderIndex;
    let nextLeaderIndex = (currentLeaderIndex + 1) % numPlayers;
    room.gameState.leaderIndex = nextLeaderIndex;
}
// ✨ MODIFICATION END


function startNextRound(room, roomId) {
    room.gameState.missionRound++;
    room.gameState.voteTrack = 0;
    nextLeader(room);
    room.gameState.status = 'proposing';
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
    // 正常结束后，清除可能存在的房主掉线计时器
    if (room.hostDisconnectTimeout) {
        clearTimeout(room.hostDisconnectTimeout);
    }
    setTimeout(() => { delete rooms[roomId]; }, 60000);
}

// ✨ MODIFICATION START: 新增一个强制结束游戏的函数
function forceEndGame(roomId, reason) {
    const room = rooms[roomId];
    if (!room) return;
    console.log(`Forcing end of game for room ${roomId}. Reason: ${reason}`);
    // 向房间内所有连接的socket发送游戏被强制中止的消息
    io.to(roomId).emit('gameForciblyEnded', reason);
    
    // 清理可能存在的计时器
    if (room.hostDisconnectTimeout) {
        clearTimeout(room.hostDisconnectTimeout);
    }

    // 从服务器删除房间
    delete rooms[roomId];
}
// ✨ MODIFICATION END

server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});