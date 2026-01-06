interface FirestoreConfig {
  projectId: string;
  serviceAccount: string; // JSON string
}

interface FirestoreDocument {
  name: string;
  fields: Record<string, any>;
  createTime?: string;
  updateTime?: string;
}

export class FirestoreClient {
  private projectId: string;
  private accessToken?: string;
  private tokenExpiry?: number;
  private serviceAccount: any;

  constructor(config: FirestoreConfig) {
    this.projectId = config.projectId;
    this.serviceAccount = JSON.parse(config.serviceAccount);
  }

  /**
   * Get OAuth2 access token for Firestore API
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now()) {
      return this.accessToken;
    }

    // Create JWT for service account
    const { importPKCS8, SignJWT } = await import('jose');

    const privateKey = await importPKCS8(
      this.serviceAccount.private_key,
      'RS256'
    );

    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({
      iss: this.serviceAccount.client_email,
      sub: this.serviceAccount.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/datastore',
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.serviceAccount.private_key_id })
      .sign(privateKey);

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.statusText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 1 min early

    return this.accessToken;
  }

  /**
   * Get a document from Firestore
   */
  async getDocument(path: string): Promise<any | null> {
    const token = await this.getAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${path}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Firestore GET failed: ${response.statusText}`);
    }

    const doc = await response.json() as FirestoreDocument;
    return this.parseDocument(doc);
  }

  /**
   * Create or update a document in Firestore
   * @param path - Document path (e.g., "users/uid123")
   * @param data - Data to set
   * @param options - Optional settings: { merge: true } to only update provided fields
   */
  async setDocument(
    path: string,
    data: Record<string, any>,
    options?: { merge?: boolean }
  ): Promise<void> {
    const token = await this.getAccessToken();
    let url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${path}`;

    // When merge is true, add updateMask to only update the provided fields
    // Without updateMask, PATCH replaces the entire document (deleting unspecified fields)
    if (options?.merge) {
      const fieldPaths = this.getFieldPaths(data);
      if (fieldPaths.length > 0) {
        const maskParams = fieldPaths.map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
        url += `?${maskParams}`;
      }
    }

    const firestoreDoc = this.encodeDocument(data);

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: firestoreDoc }),
    });

    // CRITICAL: Always consume response body to prevent deadlock
    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(`Firestore SET failed: ${response.statusText} - ${responseBody}`);
    }
  }

  /**
   * Extract top-level field paths from an object for updateMask
   *
   * IMPORTANT: We intentionally do NOT recurse into nested objects because:
   * 1. Map fields like `explore_learnProgressMap` contain keys with special characters
   *    (spaces, parentheses, dots) that require backtick-quoting in Firestore paths
   * 2. For map fields, we want to replace the entire map, not individual keys
   * 3. Using top-level paths is simpler and safer for our use case
   *
   * Example: { explore_learnProgressMap: { "Opening Name (5.e4)": 1 } }
   * Returns: ["explore_learnProgressMap"] (NOT "explore_learnProgressMap.Opening Name (5.e4)")
   */
  private getFieldPaths(data: Record<string, any>): string[] {
    // Return only top-level keys - do NOT recurse into nested objects
    return Object.keys(data);
  }

  /**
   * Update a single key within a map field without replacing the entire map.
   * Uses Firestore's dot notation to merge instead of replace.
   *
   * @param docPath - Document path (e.g., "users/uid123")
   * @param mapFieldName - Name of the map field (e.g., "focused_learnProgressMap")
   * @param mapKey - Key within the map (e.g., "Italian Game_Var_SubVar")
   * @param value - Value to set
   */
  async updateMapKey(
    docPath: string,
    mapFieldName: string,
    mapKey: string,
    value: any
  ): Promise<void> {
    const token = await this.getAccessToken();

    // Escape special characters in map key with backticks for Firestore field path
    const escapedKey = `\`${mapKey}\``;
    const fieldPath = `${mapFieldName}.${escapedKey}`;

    let url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${docPath}`;
    url += `?updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`;

    // Build nested structure for the body
    const body = {
      fields: {
        [mapFieldName]: {
          mapValue: {
            fields: {
              [mapKey]: this.encodeValue(value)
            }
          }
        }
      }
    };

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseBody = await response.text();

    if (!response.ok) {
      console.error(`[Firestore] updateMapKey failed for ${fieldPath}:`, responseBody);
      throw new Error(`Firestore updateMapKey failed: ${response.statusText} - ${responseBody}`);
    }

    console.log(`[Firestore] Successfully updated ${mapFieldName}["${mapKey}"] = ${value}`);
  }

  /**
   * Update specific fields in a document
   * IMPORTANT: This method automatically adds an updateMask to prevent deleting
   * fields not included in the update. Without updateMask, Firestore PATCH
   * replaces the entire document, which would delete fields like username, etc.
   */
  async updateDocument(
    path: string,
    data: Record<string, any>,
    updateMask?: string[]
  ): Promise<void> {
    const token = await this.getAccessToken();
    let url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${path}`;

    // CRITICAL FIX: Always add updateMask to prevent deleting unspecified fields
    // If no explicit mask provided, auto-generate from the data keys
    const fieldsToUpdate = updateMask || this.getFieldPaths(data);
    if (fieldsToUpdate.length > 0) {
      const maskParams = fieldsToUpdate.map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
      url += `?${maskParams}`;
    }

    const firestoreDoc = this.encodeDocument(data);

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: firestoreDoc }),
    });

    // CRITICAL: Always consume response body to prevent deadlock
    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(`Firestore UPDATE failed: ${response.statusText} - ${responseBody}`);
    }
  }

  /**
   * Delete a document from Firestore
   */
  async deleteDocument(path: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${path}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    // CRITICAL: Always consume response body to prevent deadlock
    const responseBody = await response.text();

    if (!response.ok && response.status !== 404) {
      throw new Error(`Firestore DELETE failed: ${response.statusText} - ${responseBody}`);
    }
  }

  /**
   * List documents in a collection with pagination
   * @param collectionPath - Collection path (e.g., "users")
   * @param options - Pagination options
   * @returns Object with documents and optional nextPageToken
   */
  async listDocuments(
    collectionPath: string,
    options?: { pageSize?: number; pageToken?: string; orderBy?: string }
  ): Promise<{ documents: Array<{ id: string; data: any }>; nextPageToken?: string }> {
    const token = await this.getAccessToken();
    let url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${collectionPath}`;

    const params: string[] = [];
    if (options?.pageSize) {
      params.push(`pageSize=${options.pageSize}`);
    }
    if (options?.pageToken) {
      params.push(`pageToken=${encodeURIComponent(options.pageToken)}`);
    }
    if (options?.orderBy) {
      params.push(`orderBy=${encodeURIComponent(options.orderBy)}`);
    }

    if (params.length > 0) {
      url += `?${params.join('&')}`;
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Firestore LIST failed: ${response.statusText} - ${body}`);
    }

    const result = await response.json() as {
      documents?: FirestoreDocument[];
      nextPageToken?: string;
    };

    const documents = (result.documents || []).map(doc => ({
      id: doc.name.split('/').pop() || '',
      data: this.parseDocument(doc),
    }));

    return {
      documents,
      nextPageToken: result.nextPageToken,
    };
  }

  /**
   * Query documents in a collection
   */
  async queryDocuments(
    collectionPath: string,
    filters?: Array<{ field: string; op: string; value: any }>
  ): Promise<any[]> {
    const token = await this.getAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:runQuery`;

    const structuredQuery: any = {
      from: [{ collectionId: collectionPath.split('/').pop() }],
    };

    if (filters && filters.length > 0) {
      structuredQuery.where = {
        compositeFilter: {
          op: 'AND',
          filters: filters.map(f => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op,
              value: this.encodeValue(f.value),
            },
          })),
        },
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
    });

    if (!response.ok) {
      throw new Error(`Firestore QUERY failed: ${response.statusText}`);
    }

    const results = await response.json() as Array<{ document?: FirestoreDocument }>;
    return results
      .filter(r => r.document)
      .map(r => {
        const data = this.parseDocument(r.document!);
        // Extract document ID from document name
        // Format: "projects/{project}/databases/{database}/documents/{collection}/{docId}"
        const docName = r.document!.name;
        const docId = docName.split('/').pop();
        return { ...data, _id: docId };
      });
  }

  /**
   * Batch write operations (create, update, delete)
   */
  async batchWrite(writes: Array<{
    type: 'set' | 'update' | 'delete';
    path: string;
    data?: Record<string, any>;
  }>): Promise<void> {
    const token = await this.getAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:batchWrite`;

    const firestoreWrites = writes.map(write => {
      const docPath = `projects/${this.projectId}/databases/(default)/documents/${write.path}`;

      if (write.type === 'delete') {
        return { delete: docPath };
      }

      if (write.type === 'set') {
        return {
          update: {
            name: docPath,
            fields: this.encodeDocument(write.data!),
          },
        };
      }

      if (write.type === 'update') {
        return {
          update: {
            name: docPath,
            fields: this.encodeDocument(write.data!),
          },
          updateMask: {
            fieldPaths: Object.keys(write.data!),
          },
        };
      }
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes: firestoreWrites }),
    });

    if (!response.ok) {
      throw new Error(`Firestore BATCH WRITE failed: ${response.statusText}`);
    }
  }

  /**
   * Parse Firestore document to plain object
   */
  private parseDocument(doc: FirestoreDocument): any {
    if (!doc.fields) return {};

    const result: any = {};
    for (const [key, value] of Object.entries(doc.fields)) {
      result[key] = this.parseValue(value);
    }
    return result;
  }

  /**
   * Parse Firestore value to JS value
   */
  private parseValue(value: any): any {
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.integerValue !== undefined) return parseInt(value.integerValue);
    if (value.doubleValue !== undefined) return value.doubleValue;
    if (value.booleanValue !== undefined) return value.booleanValue;
    if (value.nullValue !== undefined) return null;
    if (value.timestampValue !== undefined) return new Date(value.timestampValue);
    if (value.arrayValue) {
      return value.arrayValue.values?.map((v: any) => this.parseValue(v)) || [];
    }
    if (value.mapValue) {
      const map: any = {};
      for (const [k, v] of Object.entries(value.mapValue.fields || {})) {
        map[k] = this.parseValue(v);
      }
      return map;
    }
    return null;
  }

  /**
   * Encode plain object to Firestore document format
   */
  private encodeDocument(data: Record<string, any>): Record<string, any> {
    const fields: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      fields[key] = this.encodeValue(value);
    }
    return fields;
  }

  /**
   * Encode JS value to Firestore value format
   */
  private encodeValue(value: any): any {
    if (value === null || value === undefined) {
      return { nullValue: null };
    }
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { integerValue: value.toString() }
        : { doubleValue: value };
    }
    if (typeof value === 'boolean') {
      return { booleanValue: value };
    }
    if (value instanceof Date) {
      return { timestampValue: value.toISOString() };
    }
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map(v => this.encodeValue(v)),
        },
      };
    }
    if (typeof value === 'object') {
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        fields[k] = this.encodeValue(v);
      }
      return { mapValue: { fields } };
    }
    return { nullValue: null };
  }
}
