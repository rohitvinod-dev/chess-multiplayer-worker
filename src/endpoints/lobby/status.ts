import type { Env } from '../../types';

/**
 * GET /api/lobby/{lobbyId}/status
 *
 * Returns current status of a lobby.
 * Used by lobby waiting screen to poll for opponent joining.
 *
 * Response:
 * - 200: { status: 'waiting' | 'playing' | 'cancelled' | 'finished', lobby: LobbyInfo }
 * - 404: Lobby not found
 */
export async function handleLobbyStatus(
  request: Request,
  env: Env,
  lobbyId: string
): Promise<Response> {
  try {
    // Get lobby from LobbyList Durable Object
    const lobbyListId = env.LOBBY_LIST.idFromName('global');
    const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

    const response = await lobbyListStub.fetch(
      `https://lobby-list/get/${lobbyId}`,
      {
        method: 'GET',
      }
    );

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: 'Lobby not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const lobby = await response.json();

    return new Response(
      JSON.stringify({
        status: lobby.status,
        lobby: lobby,
        // Include game info if status is 'playing'
        ...(lobby.status === 'playing' && lobby.gameRoomId
          ? {
              roomId: lobby.gameRoomId,
              webSocketUrl: lobby.webSocketUrl,
              opponent: {
                id: lobby.opponentId,
                displayName: lobby.opponentDisplayName,
                rating: lobby.opponentRating,
              },
            }
          : {}),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    );
  } catch (error) {
    console.error('Error fetching lobby status:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
