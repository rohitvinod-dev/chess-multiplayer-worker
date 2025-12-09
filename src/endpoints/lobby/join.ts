import type { JoinLobbyRequest } from '../../types/lobby';

/**
 * POST /api/lobby/join
 *
 * Join an existing lobby as a player
 * Now notifies LobbyRoom via WebSocket to alert waiting creator in real-time!
 */
export async function joinLobbyHandler(
  request: Request,
  env: any,
  userId: string
): Promise<Response> {
  try {
    const body = await request.json() as JoinLobbyRequest;

    if (!body.lobbyId || !body.playerDisplayName) {
      return new Response(JSON.stringify({
        error: 'Missing required fields',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get LobbyRoom Durable Object (handles WebSocket notifications)
    const lobbyRoomId = env.LOBBY_ROOM.idFromName(body.lobbyId);
    const lobbyRoomStub = env.LOBBY_ROOM.get(lobbyRoomId);

    // Join lobby - LobbyRoom will handle:
    // 1. Notify creator via WebSocket (real-time!)
    // 2. Create game room
    // 3. Return game info to both players
    const joinResponse = await lobbyRoomStub.fetch(new Request('https://lobby-room/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: userId,
        displayName: body.playerDisplayName,
        rating: body.playerRating || 1200,
        isProvisional: body.isProvisional || false,
      }),
    }));

    if (!joinResponse.ok) {
      const error = await joinResponse.json();
      return new Response(JSON.stringify({
        error: error.error || 'Failed to join lobby',
      }), {
        status: joinResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await joinResponse.json();

    // Update LobbyList to mark as 'playing'
    const lobbyListId = env.LOBBY_LIST.idFromName('global');
    const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

    await lobbyListStub.fetch(new Request(
      `https://lobby-list/update/${body.lobbyId}`,
      {
        method: 'POST',
        body: JSON.stringify({
          status: 'playing',
          startedAt: Date.now(),
          opponentId: userId,
          opponentDisplayName: body.playerDisplayName,
          opponentRating: body.playerRating || 1200,
        }),
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    console.log(`User ${userId} joined lobby ${body.lobbyId}, creator notified via WebSocket!`);

    // Return game room info to joining player
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error joining lobby:', error);
    return new Response(JSON.stringify({
      error: 'Failed to join lobby',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
