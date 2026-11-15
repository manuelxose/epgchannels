/**
 * ETag generation without buffering surprises.
 *
 * JSON responses are wrapped so an `ETag` header is set from the exact body
 * that will be sent, and a matching `If-None-Match` short-circuits to 304.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';

function weakEtag(body: string): string {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`;
}

export const etagJson: RequestHandler = (_request: Request, response: Response, next: NextFunction) => {
  const originalJson = response.json.bind(response);
  response.json = ((body: unknown) => {
    let serialised: string;
    try {
      serialised = JSON.stringify(body);
    } catch {
      return originalJson(body);
    }
    const tag = weakEtag(serialised);
    response.setHeader('etag', tag);
    const request = response.req;
    const ifNoneMatch = request?.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === tag && response.statusCode === 200) {
      response.status(304).end();
      return response;
    }
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', Buffer.byteLength(serialised).toString());
    response.end(serialised);
    return response;
  }) as Response['json'];
  next();
};
