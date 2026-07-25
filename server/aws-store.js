/**
 * Optional AWS DynamoDB dual-write for HAR capture.
 * Uses default AWS credential chain (~/.aws/credentials).
 * Env:
 *   HAR_AWS_DUALWRITE=1 (default on if region set)
 *   HAR_AWS_REGION=ap-southeast-1
 *   HAR_DDB_COOKIES=har-capture-cookies
 *   HAR_DDB_REQUESTS=har-capture-requests
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.HAR_AWS_REGION || process.env.AWS_REGION || 'ap-southeast-1';
const COOKIES_TABLE = process.env.HAR_DDB_COOKIES || 'har-capture-cookies';
const REQUESTS_TABLE = process.env.HAR_DDB_REQUESTS || 'har-capture-requests';
const ENABLED = (process.env.HAR_AWS_DUALWRITE ?? '1') !== '0';

let doc = null;

function client() {
  if (!ENABLED) return null;
  if (doc) return doc;
  try {
    const raw = new DynamoDBClient({ region: REGION });
    doc = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
    return doc;
  } catch (e) {
    console.warn('[aws-store] init failed', e.message);
    return null;
  }
}

export function awsEnabled() {
  return ENABLED && !!client();
}

export async function awsPutCookie(sessionId, row) {
  const c = client();
  if (!c) return;
  const ts = row.ts || Date.now();
  const host = row.host || 'unknown';
  const name = row.name || 'cookie';
  try {
    await c.send(
      new PutCommand({
        TableName: COOKIES_TABLE,
        Item: {
          pk: `session#${sessionId}`,
          sk: `cookie#${ts}#${host}#${name}#${Math.random().toString(36).slice(2, 8)}`,
          sessionId: Number(sessionId),
          host,
          name,
          value: String(row.value || '').slice(0, 4000),
          domain: row.domain || null,
          httpOnly: !!row.httpOnly,
          secure: !!row.secure,
          path: row.path || null,
          source: row.source || null,
          url: row.url || null,
          raw: row.raw ? String(row.raw).slice(0, 4000) : null,
          ts,
          gsi1pk: `host#${host}`,
          gsi1sk: `name#${name}#${ts}`,
        },
      }),
    );
  } catch (e) {
    console.warn('[aws-store] put cookie', e.message);
  }
}

export async function awsPutRequest(sessionId, req) {
  const c = client();
  if (!c || !req?.id) return;
  try {
    // strip huge bodies for remote cost control
    const slim = { ...req };
    if (typeof slim.responseBody === 'string' && slim.responseBody.length > 200_000) {
      slim.responseBody = slim.responseBody.slice(0, 200_000);
      slim.responseBodyTruncated = true;
    }
    if (typeof slim.requestBody === 'string' && slim.requestBody.length > 200_000) {
      slim.requestBody = slim.requestBody.slice(0, 200_000);
      slim.requestBodyTruncated = true;
    }
    await c.send(
      new PutCommand({
        TableName: REQUESTS_TABLE,
        Item: {
          pk: `session#${sessionId}`,
          sk: `req#${req.startedAt || Date.now()}#${req.id}`,
          sessionId: Number(sessionId),
          id: req.id,
          host: req.host || null,
          method: req.method || null,
          type: req.type || null,
          status: req.status ?? null,
          url: req.url || null,
          startedAt: req.startedAt || Date.now(),
          data: JSON.stringify(slim).slice(0, 350_000),
        },
      }),
    );
  } catch (e) {
    console.warn('[aws-store] put request', e.message);
  }
}

export async function awsListCookies(sessionId, { limit = 200 } = {}) {
  const c = client();
  if (!c) return [];
  try {
    const out = await c.send(
      new QueryCommand({
        TableName: COOKIES_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: {
          ':pk': `session#${sessionId}`,
          ':sk': 'cookie#',
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return out.Items || [];
  } catch (e) {
    console.warn('[aws-store] list cookies', e.message);
    return [];
  }
}
