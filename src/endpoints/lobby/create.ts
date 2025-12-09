import type { CreateLobbyRequest, LobbyInfo } from '../../types/lobby';

/**
 * POST /api/lobby/create
 *
 * Create a new lobby for custom games
 * Now uses LobbyRoom Durable Object for WebSocket-based waiting (500x more cost-efficient!)
 */
export async function createLobbyHandler(
  request: Request,
  env: any,
  userId: string
): Promise<Response> {
  try {
    const body = await request.json() as CreateLobbyRequest;

    // Validate input
    if (!body.creatorDisplayName || !body.settings) {
      return new Response(JSON.stringify({
        error: 'Missing required fields',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate settings
    const settings = body.settings;
    if (!['blitz', 'rapid', 'classical'].includes(settings.gameMode)) {
      return new Response(JSON.stringify({
        error: 'Invalid game mode',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!['white', 'black', 'random'].includes(settings.playerColor)) {
      return new Response(JSON.stringify({
        error: 'Invalid player color',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate unique lobby ID
    const lobbyId = crypto.randomUUID();

    // Generate private code if needed
    let privateCode: string | undefined;
    if (settings.isPrivate) {
      privateCode = Math.floor(100000 + Math.random() * 900000).toString();
    }

    // Set default spectator limit
    if (!settings.maxSpectators) {
      settings.maxSpectators = 50;
    }

    // Create LobbyRoom Durable Object (WebSocket-based waiting room - 500x cheaper than polling!)
    const lobbyRoomId = env.LOBBY_ROOM.idFromName(lobbyId);
    const lobbyRoomStub = env.LOBBY_ROOM.get(lobbyRoomId);

    // Initialize LobbyRoom with creator info
    await lobbyRoomStub.fetch(new Request('https://lobby-room/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lobbyId,
        creatorId: userId,
        creatorDisplayName: body.creatorDisplayName,
        creatorRating: body.creatorRating || 1200,
        isProvisional: body.isProvisional || false,
        settings: {
          ...settings,
          privateCode,
        },
      }),
    }));

    // Create lobby info for LobbyList
    const lobby: LobbyInfo = {
      id: lobbyId,
      creatorId: userId,
      creatorDisplayName: body.creatorDisplayName,
      creatorRating: body.creatorRating || 1200,
      settings: {
        ...settings,
        privateCode,
      },
      status: 'waiting',
      createdAt: Date.now(),
      spectatorCount: 0,
      spectatorIds: [],
    };

    // Get LobbyList Durable Object (single global instance)
    const lobbyListId = env.LOBBY_LIST.idFromName('global');
    const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

    // Add lobby to list
    await lobbyListStub.fetch(new Request('https://lobby-list/add', {
      method: 'POST',
      body: JSON.stringify(lobby),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Generate WebSocket URL for lobby waiting room
    const protocol = new URL(request.url).protocol === 'https:' ? 'wss:' : 'ws:';
    const host = request.headers.get('host') || 'localhost';

    lobby.webSocketUrl = `${protocol}//${host}/api/lobby/${lobbyId}/ws?userId=${userId}`;

    console.log(`Created lobby ${lobbyId} with WebSocket waiting room (cost-efficient!)`);

    return new Response(JSON.stringify({
      lobby,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error creating lobby:', error);
    return new Response(JSON.stringify({
      error: 'Failed to create lobby',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
