import type { LobbyListResponse } from '../../types/lobby';

/**
 * GET /api/lobby/list
 *
 * Get all active lobbies
 */
export async function listLobbiesHandler(
  request: Request,
  env: any
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as 'waiting' | 'playing' | undefined;

    // Get LobbyList Durable Object
    const lobbyListId = env.LOBBY_LIST.idFromName('global');
    const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

    // Fetch lobbies
    const response = await lobbyListStub.fetch(new Request(
      `https://lobby-list/list?status=${status || ''}&includePrivate=false`,
      { method: 'GET' }
    ));

    const data = await response.json() as LobbyListResponse;

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error listing lobbies:', error);
    return new Response(JSON.stringify({
      error: 'Failed to list lobbies',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
