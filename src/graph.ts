const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphError {
  code: string;
  message: string;
}

export interface GraphMailMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  isRead?: boolean;
}

export async function getAccessToken(
  clientId: string,
  refreshToken: string
): Promise<{ token?: string; newRefreshToken?: string; error?: GraphError }> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://graph.microsoft.com/.default',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, string>;
      return {
        error: {
          code: err.error || 'TOKEN_FAILED',
          message: err.error_description || `Token request failed with status ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    return {
      token: data.access_token,
      newRefreshToken: data.refresh_token,
    };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error during token request: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

export async function fetchEmails(
  accessToken: string,
  options: { folder?: string; top?: number; skip?: number; keyword?: string; includeBody?: boolean } = {}
): Promise<{ items?: GraphMailMessage[]; error?: GraphError }> {
  const { folder = 'inbox', top = 20, skip = 0, keyword, includeBody = false } = options;

  if (folder === 'all') {
    const [inbox, junk] = await Promise.all([
      fetchEmails(accessToken, { folder: 'inbox', top, skip: 0, keyword, includeBody }),
      fetchEmails(accessToken, { folder: 'junkemail', top, skip: 0, keyword, includeBody }),
    ]);
    if (inbox.error && junk.error) return { error: inbox.error };
    const merged = [...(inbox.items ?? []), ...(junk.items ?? [])]
      .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
      .slice(0, top);
    return { items: merged };
  }

  try {
    const selectFields = includeBody
      ? 'id,subject,bodyPreview,body,from,receivedDateTime,isRead'
      : 'id,subject,bodyPreview,from,receivedDateTime,isRead';
    const params = new URLSearchParams({
      $top: String(top),
      $skip: String(skip),
      $orderby: 'receivedDateTime desc',
      $select: selectFields,
    });

    if (keyword) {
      params.set('$search', `"${keyword}"`);
    }

    const folderMap: Record<string, string> = {
      inbox: 'inbox',
      junkemail: 'junkemail',
      deleteditems: 'deleteditems',
    };
    const targetFolder = folderMap[folder] || 'inbox';
    const url = `${GRAPH_BASE}/me/mailFolders/${targetFolder}/messages?${params.toString()}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (keyword) {
      headers['ConsistencyLevel'] = 'eventual';
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: GraphError };
      return {
        error: err.error ?? {
          code: `HTTP_${res.status}`,
          message: `Graph API returned status ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as { value?: GraphMailMessage[] };
    return { items: data.value ?? [] };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}
