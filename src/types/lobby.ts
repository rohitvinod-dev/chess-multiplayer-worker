// Lobby system type definitions

export interface LobbySettings {
  // Color selection
  playerColor: 'white' | 'black' | 'random';

  // Opening selection (null for normal/no specific opening)
  openingId?: string;
  openingName?: string;
  openingFen?: string; // Starting position if playing specific opening

  // Game mode
  gameMode: 'blitz' | 'rapid' | 'classical';

  // Privacy settings
  isPrivate: boolean;
  privateCode?: string; // 6-digit code for private lobbies

  // Spectator settings
  allowSpectators: boolean;
  maxSpectators: number; // Default 50
}

export interface LobbyInfo {
  id: string;
  creatorId: string;
  creatorDisplayName: string;
  creatorRating: number;
  settings: LobbySettings;

  // Current state
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
  startedAt?: number;

  // Players (null if waiting for player)
  whitePlayerId?: string;
  whiteDisplayName?: string;
  whiteRating?: number;

  blackPlayerId?: string;
  blackDisplayName?: string;
  blackRating?: number;

  // Spectators
  spectatorCount: number;
  spectatorIds: string[];

  // Game room connection
  gameRoomId: string;
  webSocketUrl?: string;
}

export interface CreateLobbyRequest {
  creatorId: string;
  creatorDisplayName: string;
  creatorRating: number;
  settings: LobbySettings;
}

export interface JoinLobbyRequest {
  lobbyId: string;
  playerId: string;
  playerDisplayName: string;
  playerRating: number;
  isProvisional: boolean;
}

export interface SpectateLobbyRequest {
  lobbyId: string;
  spectatorId: string;
  spectatorDisplayName: string;
}

export interface LobbyListResponse {
  lobbies: LobbyInfo[];
  total: number;
}
