/**
 * DELETE /api/lobby/:id
 *
 * Delete a lobby (creator only)
 */
export async function deleteLobbyHandler(
  request: Request,
  env: any,
  userId: string,
  lobbyId: string
): Promise<Response> {
  try {
    // Get LobbyList Durable Object
    const lobbyListId = env.LOBBY_LIST.idFromName('global');
    const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

    // Fetch lobby to verify ownership
    const lobbyResponse = await lobbyListStub.fetch(new Request(
      `https://lobby-list/lobby/${lobbyId}`,
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

    // Verify creator
    if (lobby.creatorId !== userId) {
      return new Response(JSON.stringify({
        error: 'Only the lobby creator can delete it',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete lobby
    await lobbyListStub.fetch(new Request(
      `https://lobby-list/remove/${lobbyId}`,
      { method: 'DELETE' }
    ));

    console.log(`Lobby ${lobbyId} deleted by creator ${userId}`);

    return new Response(JSON.stringify({
      success: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error deleting lobby:', error);
    return new Response(JSON.stringify({
      error: 'Failed to delete lobby',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
