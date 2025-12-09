import type { SpectateLobbyRequest } from '../../types/lobby';

/**
 * POST /api/lobby/spectate
 *
 * Join a lobby as a spectator
 */
export async function spectateLobbyHandler(
  request: Request,
  env: any,
  userId: string
): Promise<Response> {
  try {
    const body = await request.json() as SpectateLobbyRequest;

    if (!body.lobbyId || !body.spectatorDisplayName) {
      return new Response(JSON.stringify({
        error: 'Missing required fields',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get LobbyList Durable Object
    const lobbyListId = env.LOBBY_LIST.idFromName('global');
    const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

    // Fetch lobby
    const lobbyResponse = await lobbyListStub.fetch(new Request(
      `https://lobby-list/lobby/${body.lobbyId}`,
      { method: 'GET' }
    ));

    if (!lobbyResponse.ok) {
      return new Response(JSON.stringify({
        error: 'Lobby not found',
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const lobby = await lobbyResponse.json();

    // Check if spectators are allowed
    if (!lobby.settings.allowSpectators) {
      return new Response(JSON.stringify({
        error: 'Spectators not allowed in this lobby',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Add spectator to lobby list
    try {
      await lobbyListStub.fetch(new Request(
        `https://lobby-list/spectator/add`,
        {
          method: 'POST',
          body: JSON.stringify({ lobbyId: body.lobbyId, spectatorId: userId }),
          headers: { 'Content-Type': 'application/json' },
        }
      ));
    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to join as spectator',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate WebSocket URL for spectator
    const protocol = new URL(request.url).protocol === 'https:' ? 'wss:' : 'ws:';
    const host = request.headers.get('host') || 'localhost';

    const webSocketUrl = `${protocol}//${host}/game/${lobby.gameRoomId}?` +
      `playerId=${userId}&` +
      `displayName=${encodeURIComponent(body.spectatorDisplayName)}&` +
      `mode=spectator`;

    console.log(`User ${userId} joined lobby ${body.lobbyId} as spectator`);

    return new Response(JSON.stringify({
      lobbyId: body.lobbyId,
      webSocketUrl,
      whitePlayer: lobby.whiteDisplayName,
      blackPlayer: lobby.blackDisplayName,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error spectating lobby:', error);
    return new Response(JSON.stringify({
      error: 'Failed to spectate lobby',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
