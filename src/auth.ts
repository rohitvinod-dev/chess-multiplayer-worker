import { jwtVerify, importX509 } from 'jose';

interface FirebaseUser {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

// Cache for Firebase public keys (they rotate every few hours)
const publicKeysCache: Map<string, { key: any; exp: number }> = new Map();

/**
 * Verify Firebase Auth ID token
 * @param token - Firebase ID token from Authorization header
 * @param projectId - Firebase project ID
 * @returns Decoded user info
 */
export async function verifyFirebaseToken(
  token: string,
  projectId: string
): Promise<FirebaseUser> {
  try {
    // Remove "Bearer " prefix if present
    const cleanToken = token.replace(/^Bearer\s+/i, '');

    // Decode header to get key ID
    const [headerB64] = cleanToken.split('.');
    const header = JSON.parse(atob(headerB64));
    const kid = header.kid;

    if (!kid) {
      throw new Error('No kid in token header');
    }

    // Get public key (with caching)
    const publicKey = await getFirebasePublicKey(kid);

    // Verify token
    const { payload } = await jwtVerify(cleanToken, publicKey, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    return {
      uid: payload.sub as string,
      email: payload.email as string | undefined,
      email_verified: payload.email_verified as boolean | undefined,
    };
  } catch (error) {
    console.error('Firebase token verification failed:', error);
    throw new Error('Unauthorized: Invalid Firebase token');
  }
}

/**
 * Fetch and cache Firebase public keys
 */
async function getFirebasePublicKey(kid: string): Promise<any> {
  // Check cache first
  const cached = publicKeysCache.get(kid);
  if (cached && cached.exp > Date.now()) {
    return cached.key;
  }

  // Fetch public keys from Google
  const response = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );

  if (!response.ok) {
    throw new Error('Failed to fetch Firebase public keys');
  }

  const keys = await response.json() as Record<string, string>;
  const certString = keys[kid];

  if (!certString) {
    throw new Error(`Public key not found for kid: ${kid}`);
  }

  // Import X509 certificate
  const publicKey = await importX509(certString, 'RS256');

  // Cache for 1 hour (Firebase keys rotate every few hours)
  publicKeysCache.set(kid, {
    key: publicKey,
    exp: Date.now() + 60 * 60 * 1000,
  });

  return publicKey;
}

/**
 * Extract and verify token from request headers
 */
export async function authenticateRequest(
  request: Request,
  projectId: string
): Promise<FirebaseUser> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    throw new Error('Unauthorized: Missing Authorization header');
  }

  return verifyFirebaseToken(authHeader, projectId);
}
