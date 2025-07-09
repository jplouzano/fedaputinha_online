const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = {};

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('createRoom', (playerName) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: [{
        id: socket.id,
        name: playerName,
        isHost: true,
        ready: false
      }],
      gameState: null,
      status: 'waiting'
    };
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
    updateRoom(roomId);
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', 'Sala não encontrada');
      return;
    }

    if (rooms[roomId].players.length >= 5) {
      socket.emit('error', 'Sala cheia (máximo 5 jogadores)');
      return;
    }

    rooms[roomId].players.push({
      id: socket.id,
      name: playerName,
      isHost: false,
      ready: false
    });
    socket.join(roomId);
    updateRoom(roomId);
  });

  socket.on('startGame', (roomId) => {
    if (!rooms[roomId] || rooms[roomId].status !== 'waiting') return;

    const room = rooms[roomId];
    const host = room.players.find(p => p.isHost);
    
    if (host && host.id === socket.id) {
      room.status = 'playing';
      room.gameState = initializeGameState(room.players);
      io.to(roomId).emit('gameStarted', room.gameState);
      updateRoom(roomId);
    }
  });

  socket.on('placeBet', ({ roomId, playerId, bet }) => {
    if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;
    
    const room = rooms[roomId];
    const playerIndex = room.gameState.players.findIndex(p => p.id === playerId);
    
    if (playerIndex !== -1) {
      room.gameState.players[playerIndex].bet = parseInt(bet);
      io.to(roomId).emit('gameStateUpdated', room.gameState);
      
      // Verificar se todas as apostas foram feitas
      if (room.gameState.players.every(p => p.eliminated || p.bet !== null)) {
        startPlayingPhase(room);
      } else {
        moveToNextPlayer(room);
      }
    }
  });

  socket.on('playCard', ({ roomId, playerId, cardIndex }) => {
    if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;
    
    const room = rooms[roomId];
    const gameState = room.gameState;
    const playerIndex = gameState.players.findIndex(p => p.id === playerId);
    
    if (playerIndex === -1 || playerIndex !== gameState.currentPlayerIndex) return;
    
    const player = gameState.players[playerIndex];
    const card = player.cards[cardIndex];
    
    // Remover carta do jogador
    player.cards.splice(cardIndex, 1);
    
    // Adicionar à rodada atual
    gameState.currentTrick.push({ playerIndex, card });
    
    // Atualizar estado do jogo
    if (gameState.currentTrick.length === 1) {
      gameState.firstCardPlayed = card;
    }
    
    // Mover para o próximo jogador
    moveToNextPlayer(room);
    
    // Verificar se a rodada está completa
    if (gameState.currentTrick.length === gameState.players.filter(p => !p.eliminated).length) {
      setTimeout(() => {
        determineTrickWinner(room);
      }, 1500);
    }
    
    io.to(roomId).emit('gameStateUpdated', gameState);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Remover jogador de todas as salas
    for (const roomId in rooms) {
      const room = rooms[roomId];
      room.players = room.players.filter(p => p.id !== socket.id);
      
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        // Se o host sair, designar novo host
        if (!room.players.some(p => p.isHost)) {
          room.players[0].isHost = true;
        }
        updateRoom(roomId);
      }
    }
  });
});

function updateRoom(roomId) {
  const room = rooms[roomId];
  io.to(roomId).emit('roomUpdated', {
    players: room.players,
    status: room.status
  });
}

function initializeGameState(players) {
  // Criar baralho
  const deck = createDeck();
  
  // Embaralhar
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  
  // Determinar cartas por jogador (começa com 1)
  const cardsPerPlayer = 1;
  
  // Distribuir cartas
  const gamePlayers = players.map((player, index) => ({
    id: player.id,
    name: player.name,
    cards: [],
    bet: null,
    wins: 0,
    points: 0,
    isHuman: index === 0, // Primeiro jogador é humano
    eliminated: false
  }));
  
  for (let i = 0; i < cardsPerPlayer * players.length; i++) {
    const playerIndex = Math.floor(i / cardsPerPlayer) % players.length;
    gamePlayers[playerIndex].cards.push(deck[i]);
  }
  
  return {
    players: gamePlayers,
    currentRound: 1,
    cardsPerPlayer: cardsPerPlayer,
    direction: 1,
    maxCardsPerPlayer: Math.floor(deck.length / players.length),
    currentPlayerIndex: 0,
    currentTurn: 0,
    firstCardPlayed: null,
    currentTrick: [],
    dealerIndex: 0,
    gameStarted: true,
    bettingPhase: true,
    playingPhase: false,
    blindRound: cardsPerPlayer === 1,
    selectedCardIndex: null
  };
}

function createDeck() {
  const suits = ['paus', 'copas', 'espadas', 'ouros'];
  const values = ['A', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];
  const deck = [];
  
  for (const suit of suits) {
    for (const value of values) {
      deck.push({ value, suit });
    }
  }
  
  return deck;
}

function moveToNextPlayer(room) {
  const gameState = room.gameState;
  const activePlayers = gameState.players.filter(p => !p.eliminated);
  
  do {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  } while (gameState.players[gameState.currentPlayerIndex].eliminated);
  
  io.to(room.id).emit('gameStateUpdated', gameState);
}

function startPlayingPhase(room) {
  const gameState = room.gameState;
  gameState.bettingPhase = false;
  gameState.playingPhase = true;
  gameState.currentTurn = 0;
  gameState.currentTrick = [];
  gameState.firstCardPlayed = null;
  gameState.selectedCardIndex = null;
  
  // Primeiro jogador é o próximo ao dealer
  gameState.currentPlayerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
  
  // Pular jogadores eliminados
  while (gameState.players[gameState.currentPlayerIndex].eliminated) {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  }
  
  io.to(room.id).emit('gameStateUpdated', gameState);
}

function determineTrickWinner(room) {
  const gameState = room.gameState;
  const trick = gameState.currentTrick;
  
  if (trick.length === 0) return;
  
  const leadingSuit = trick[0].card.suit;
  let winningIndex = 0;
  let maxStrength = 0;
  let isTie = false;
  
  // Determinar carta mais forte
  trick.forEach((play, index) => {
    const cardKey = `${play.card.value}-${play.card.suit}`;
    const strength = getCardStrength(cardKey);
    
    if (strength === maxStrength) {
      isTie = true;
    } else if (strength > maxStrength) {
      maxStrength = strength;
      winningIndex = index;
      isTie = false;
    }
  });
  
  if (isTie) {
    // Empate - ninguém ganha
    gameState.currentTurn++;
    
    if (gameState.currentTurn === gameState.cardsPerPlayer) {
      endRound(room);
    } else {
      // Nova rodada com mesmo jogador
      gameState.currentTrick = [];
      gameState.firstCardPlayed = null;
    }
  } else {
    // Temos um vencedor
    const winningPlayerIndex = trick[winningIndex].playerIndex;
    gameState.players[winningPlayerIndex].wins++;
    gameState.currentTurn++;
    
    if (gameState.currentTurn === gameState.cardsPerPlayer) {
      endRound(room);
    } else {
      // Nova rodada com o vencedor como primeiro
      gameState.currentPlayerIndex = winningPlayerIndex;
      gameState.currentTrick = [];
      gameState.firstCardPlayed = null;
    }
  }
  
  io.to(room.id).emit('gameStateUpdated', gameState);
}

function endRound(room) {
  const gameState = room.gameState;
  
  // Calcular pontos
  gameState.players.forEach(player => {
    if (!player.eliminated) {
      let difference = Math.abs(player.bet - player.wins);
      
      if (player.bet === 0 && player.wins > 0) {
        difference = player.wins;
      }
      
      player.points += difference;
      
      if (player.points >= 5) {
        player.eliminated = true;
      }
    }
  });
  
  // Verificar se o jogo terminou
  const activePlayers = gameState.players.filter(p => !p.eliminated);
  if (activePlayers.length <= 1) {
    room.status = 'finished';
    io.to(room.id).emit('gameFinished', {
      winner: activePlayers[0] || null
    });
    return;
  }
  
  // Mover posição do dealer
  do {
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
  } while (gameState.players[gameState.dealerIndex].eliminated);
  
  // Atualizar cartas por jogador para a próxima rodada
  gameState.cardsPerPlayer += gameState.direction;
  
  // Verificar se precisa mudar a direção
  if (gameState.cardsPerPlayer === 1) {
    gameState.direction = 1;
  } else if (gameState.cardsPerPlayer === gameState.maxCardsPerPlayer) {
    gameState.direction = -1;
  }
  
  // Preparar nova rodada
  gameState.currentRound++;
  gameState.bettingPhase = true;
  gameState.playingPhase = false;
  gameState.blindRound = gameState.cardsPerPlayer === 1;
  
  // Distribuir novas cartas
  const deck = createDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  
  gameState.players.forEach(player => {
    if (!player.eliminated) {
      player.cards = [];
      player.bet = null;
      player.wins = 0;
    }
  });
  
  for (let i = 0; i < gameState.cardsPerPlayer * gameState.players.length; i++) {
    const playerIndex = (gameState.dealerIndex + 1 + Math.floor(i / gameState.cardsPerPlayer)) % gameState.players.length;
    if (!gameState.players[playerIndex].eliminated) {
      gameState.players[playerIndex].cards.push(deck[i]);
    }
  }
  
  // Começar fase de apostas
  gameState.currentPlayerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
  while (gameState.players[gameState.currentPlayerIndex].eliminated) {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  }
  
  io.to(room.id).emit('gameStateUpdated', gameState);
}

function getCardStrength(cardKey) {
  const strengths = {
    '4-paus': 17, '7-copas': 16, 'A-espadas': 15, '7-ouros': 14,
    '3-paus': 13, '3-copas': 13, '3-espadas': 13, '3-ouros': 13,
    '2-paus': 12, '2-copas': 12, '2-espadas': 12, '2-ouros': 12,
    'A-paus': 11, 'A-copas': 11, 'A-ouros': 11,
    'K-paus': 10, 'K-copas': 10, 'K-espadas': 10, 'K-ouros': 10,
    'J-paus': 9, 'J-copas': 9, 'J-espadas': 9, 'J-ouros': 9,
    'Q-paus': 8, 'Q-copas': 8, 'Q-espadas': 8, 'Q-ouros': 8,
    '7-paus': 7, '7-espadas': 7,
    '6-paus': 6, '6-copas': 6, '6-espadas': 6, '6-ouros': 6,
    '5-paus': 5, '5-copas': 5, '5-espadas': 5, '5-ouros': 5,
    '4-copas': 4, '4-espadas': 4, '4-ouros': 4
  };
  
  return strengths[cardKey] || 0;
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));